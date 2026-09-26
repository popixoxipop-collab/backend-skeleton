import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	NATIVE_SERVER_PROTOCOL,
	analyzeCSharpAspNetSource,
	analyzeGoGinSource,
	analyzeRustServerSource,
	analyzeNativeServerFiles,
	decodeNdjsonLine,
	encodeNdjson,
	handleAnalyzeRequest,
	validateMessage,
	runNativeServerWorker,
	NativeWorkerRunError,
} from '../../scanners/language/native-server/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(HERE, '../../scanners/language/native-server/worker.mjs');

function request(overrides = {}) {
	return { protocol: NATIVE_SERVER_PROTOCOL, kind: 'analyze-request', requestId: 'req-1', language: 'go', file: 'main.go', source: 'package main', ...overrides };
}

test('transport: encode/decode round-trip validates the version and request ID', () => {
	const line = encodeNdjson(request());
	assert.deepEqual(decodeNdjsonLine(Buffer.from(line)), request());
});

test('transport: malformed UTF-8 is rejected rather than replacement-decoded', () => {
	assert.throws(() => decodeNdjsonLine(Buffer.from([0xc3, 0x28])), /valid UTF-8/);
});

test('transport: a single CRLF-terminated message is accepted for Windows helpers', () => {
	const line = JSON.stringify(request()) + '\r\n';
	assert.deepEqual(decodeNdjsonLine(Buffer.from(line)), request());
});

test('transport: one line cannot smuggle a second protocol message', () => {
	const line = JSON.stringify(request()) + '\n' + JSON.stringify(request({ requestId: 'req-2' }));
	assert.throws(() => decodeNdjsonLine(line), /exactly one/);
});

test('transport: protocol version mismatch is rejected', () => {
	assert.throws(() => decodeNdjsonLine(JSON.stringify(request({ protocol: 'bskel.native-language/999' }))), /unsupported protocol/);
});

test('transport: output budget is enforced', () => {
	assert.throws(() => encodeNdjson(request({ source: 'x'.repeat(500) }), { maxOutputBytes: 100 }), /maxOutputBytes/);
});

test('Go/Gin: nested literal groups compose deterministic absolute routes', () => {
	const src = `package main
func setup() {
 r := gin.Default()
 api := r.Group("/api")
 v1 := api.Group("/v1")
 v1.GET("/users/:id", users.Get)
 api.POST("/users", createUser)
}`;
	const result = analyzeGoGinSource(src, { file: 'routes.go' });
	assert.deepEqual(result.routes.map(({ method, path, handler }) => ({ method, path, handler })), [
		{ method: 'GET', path: '/api/v1/users/:id', handler: 'users.Get' },
		{ method: 'POST', path: '/api/users', handler: 'createUser' },
	]);
	assert.equal(result.diagnostics.length, 0);
	assert.deepEqual(analyzeGoGinSource(src, { file: 'routes.go' }), result);
});

test('Go/Gin: var declarations are accepted without widening to unrelated method calls', () => {
	const src = `package main\nfunc setup(){ var r = gin.Default(); var api = r.Group("/api"); api.GET("/health", health) }`;
	const result = analyzeGoGinSource(src);
	assert.deepEqual(result.routes.map((r) => r.path), ['/api/health']);
});

test('Go/Gin: comments and unrelated GET methods are not routes', () => {
	const src = `package main
// fake := gin.Default(); fake.GET("/nope", nope)
func setup() {
 r := gin.Default()
 /* r.POST("/also-nope", nope) */
 other.GET("/not-gin", nope)
 r.GET("/real", real)
}`;
	const result = analyzeGoGinSource(src);
	assert.deepEqual(result.routes.map((r) => r.path), ['/real']);
});

test('Go/Gin: computed group and route paths remain unknown instead of guessed', () => {
	const src = `package main
func setup() {
 r := gin.New()
 api := r.Group(prefix)
 r.GET(base + "/users", list)
}`;
	const result = analyzeGoGinSource(src);
	assert.equal(result.routes.length, 0);
	assert.deepEqual(result.diagnostics.map((d) => d.code), ['GO_GIN_DYNAMIC_GROUP_PATH', 'GO_GIN_DYNAMIC_ROUTE_PATH']);
});

test('C#/ASP.NET: Minimal API nested groups compose routes', () => {
	const src = `var app = builder.Build();
var api = app.MapGroup("/api");
var v1 = api.MapGroup("/v1");
v1.MapGet("/users/{id}", GetUser);
api.MapPost("/users", CreateUser);`;
	const result = analyzeCSharpAspNetSource(src, { file: 'Program.cs' });
	assert.deepEqual(result.routes.map(({ method, path, framework }) => ({ method, path, framework })), [
		{ method: 'GET', path: '/api/v1/users/{id}', framework: 'aspnet-core-minimal' },
		{ method: 'POST', path: '/api/users', framework: 'aspnet-core-minimal' },
	]);
});

test('C#/ASP.NET: controller Route + Http attributes compose and [controller] is literal metadata', () => {
	const src = `[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult GetUser(Guid id) => Ok();

    [HttpPost]
    public IActionResult Create(CreateUser input) => Ok();
}`;
	const result = analyzeCSharpAspNetSource(src, { file: 'UsersController.cs' });
	assert.deepEqual(result.routes.map(({ method, path, handler }) => ({ method, path, handler })), [
		{ method: 'GET', path: '/api/Users/{id}', handler: 'UsersController.GetUser' },
		{ method: 'POST', path: '/api/Users', handler: 'UsersController.Create' },
	]);
	assert.deepEqual(analyzeCSharpAspNetSource(src, { file: 'UsersController.cs' }), result);
});

test('C#/ASP.NET: braces inside strings do not terminate a controller body', () => {
	const src = `[ApiController]\n[Route("api/[controller]")]\npublic class UsersController : ControllerBase\n{\n private const string Template = "{this-is-not-a-class-brace";\n [HttpGet("{id}")]\n public IActionResult Get(string id) => Ok("}");\n}`;
	const result = analyzeCSharpAspNetSource(src);
	assert.deepEqual(result.routes.map((r) => [r.method, r.path]), [['GET', '/api/Users/{id}']]);
});

test('C#/ASP.NET: action-only literal route is allowed, but missing literal route is not invented from conventions', () => {
	const src = `[ApiController]\npublic class HealthController : ControllerBase\n{\n [HttpGet("api/[controller]/[action]")]\n public IActionResult Ping() => Ok();\n [HttpPost]\n public IActionResult Reset() => Ok();\n}`;
	const result = analyzeCSharpAspNetSource(src);
	assert.deepEqual(result.routes.map((r) => [r.method, r.path]), [['GET', '/api/Health/Ping']]);
	assert.ok(result.diagnostics.some((d) => d.code === 'CSHARP_ACTION_ROUTE_UNRESOLVED'));
});

test('C#/ASP.NET: comments, computed Minimal route and MapMethods do not become invented routes', () => {
	const src = `// app.MapGet("/fake", Fake);
var app = builder.Build();
app.MapGet(prefix + "/users", GetUsers);
app.MapMethods("/known-path", new[] { "GET", "POST" }, Handler);`;
	const result = analyzeCSharpAspNetSource(src);
	assert.equal(result.routes.length, 0);
	assert.deepEqual(result.diagnostics.map((d) => d.code), ['CSHARP_DYNAMIC_MINIMAL_ROUTE', 'CSHARP_MAPMETHODS_NEEDS_METHOD_SET']);
});

test('transport/analyzer boundary: requestId and backend are bound into a validated response', () => {
	const response = handleAnalyzeRequest(request({
		requestId: 'gin-17',
		source: 'package main\nfunc setup(){ r := gin.Default(); r.GET("/health", health) }',
	}));
	assert.equal(response.requestId, 'gin-17');
	assert.equal(response.backend, 'go-static-pilot');
	assert.deepEqual(response.routes.map((r) => [r.method, r.path]), [['GET', '/health']]);
});

test('transport/analyzer boundary: direct object requests also enforce input bytes', () => {
	assert.throws(() => handleAnalyzeRequest(request({ source: 'x'.repeat(500), budget: { maxInputBytes: 100 } })), /maxInputBytes/);
});

test('transport/analyzer boundary: route budget fails closed instead of truncating facts', () => {
	assert.throws(() => handleAnalyzeRequest(request({
		source: 'package main\nfunc setup(){ r := gin.Default(); r.GET("/a", a); r.GET("/b", b) }',
		budget: { maxRoutes: 1 },
	})), /maxRoutes/);
});


test('Rust/Axum: literal route chains emit method/path/handler facts', () => {
	const src = `use axum::{Router, routing::{get, post}};
fn app() {
 let app = Router::new()
   .route("/users", get(list_users).post(create_user))
   .route("/health", get(health));
}`;
	const result = analyzeRustServerSource(src, { file: 'main.rs' });
	assert.deepEqual(result.routes.map(({ method, path, handler, framework }) => ({ method, path, handler, framework })), [
		{ method: 'GET', path: '/users', handler: 'list_users', framework: 'axum' },
		{ method: 'POST', path: '/users', handler: 'create_user', framework: 'axum' },
		{ method: 'GET', path: '/health', handler: 'health', framework: 'axum' },
	]);
	assert.equal(result.diagnostics.length, 0);
});

test('Rust/Axum: nested routers compose prefixes and suppress child-only exposure when nested', () => {
	const src = `fn app() {
 let api = Router::new().route("/users", get(users::list));
 let app = Router::new().nest("/api", api).route("/health", get(health));
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => [r.method, r.path, r.handler]), [
		['GET', '/api/users', 'users::list'],
		['GET', '/health', 'health'],
	]);
});

test('Rust/Axum: computed route/nest inputs remain diagnostics, not guessed routes', () => {
	const src = `fn app() {
 let api = Router::new().route(path(), get(list));
 let app = Router::new().nest(prefix, api);
}`;
	const result = analyzeRustServerSource(src);
	assert.equal(result.routes.length, 0);
	assert.ok(result.diagnostics.some((d) => d.code === 'RUST_AXUM_DYNAMIC_ROUTE_PATH'));
	assert.ok(result.diagnostics.some((d) => d.code === 'RUST_AXUM_DYNAMIC_NEST_PATH'));
});

test('Rust/Axum: comments and raw strings containing route-looking text never become routes', () => {
	const src = String.raw`fn app() {
 // let fake = Router::new().route("/comment", get(nope));
 let text = r#"Router::new().route("/raw", get(nope))"#;
 let app = Router::new().route("/real", get(real));
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => r.path), ['/real']);
});

test('Rust/Axum: Rust lifetimes do not swallow following route syntax', () => {
	const src = `fn borrow<'a>(x: &'a str) -> &'a str { x }
fn app() {
 let app = Router::new().route("/life", get(life));
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => r.path), ['/life']);
});

test('Rust/Actix: direct App route emits literal method/path/handler fact', () => {
	const src = `use actix_web::{web, App};
fn app() {
 let app = App::new().route("/users", web::get().to(list_users));
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map(({ method, path, handler, framework }) => ({ method, path, handler, framework })), [
		{ method: 'GET', path: '/users', handler: 'list_users', framework: 'actix-web' },
	]);
});

test('Rust/Actix: literal web::scope composes contained route prefixes', () => {
	const src = `fn app() {
 let app = App::new().service(
   web::scope("/api")
     .route("/users", web::get().to(list_users))
     .route("/users", web::post().to(create_user))
 );
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => [r.method, r.path]), [
		['GET', '/api/users'],
		['POST', '/api/users'],
	]);
});

test('Rust/Actix: computed route paths and unsupported method builders do not become facts', () => {
	const src = `fn app() {
 let app = App::new()
   .route(path(), web::get().to(list_users))
   .route("/custom", web::method(Method::CONNECT).to(connect));
}`;
	const result = analyzeRustServerSource(src);
	assert.equal(result.routes.length, 0);
	assert.ok(result.diagnostics.some((d) => d.code === 'RUST_ACTIX_DYNAMIC_ROUTE_PATH'));
	assert.ok(result.diagnostics.some((d) => d.code === 'RUST_ACTIX_UNKNOWN_ROUTE_HANDLER'));
});

test('transport/analyzer boundary: Rust requests bind to the Rust pilot backend', () => {
	const response = handleAnalyzeRequest(request({
		requestId: 'rust-1',
		language: 'rust',
		file: 'main.rs',
		source: 'fn app(){ let app = Router::new().route("/health", get(health)); }',
	}));
	assert.equal(response.backend, 'rust-static-pilot');
	assert.deepEqual(response.routes.map((r) => [r.framework, r.method, r.path]), [['axum', 'GET', '/health']]);
});


test('transport: malformed route facts are rejected at the response boundary', () => {
	assert.throws(() => validateMessage({
		protocol: NATIVE_SERVER_PROTOCOL,
		kind: 'analyze-response',
		requestId: 'bad-route',
		language: 'go',
		backend: 'test-backend',
		routes: [{ method: 'get', path: 'users', handler: null, framework: 'gin', confidence: 'static-literal', source: { file: 'x.go', line: 1, index: 0 } }],
		diagnostics: [],
	}), /route method|route path/);
});

test('transport: malformed diagnostics are rejected at the response boundary', () => {
	assert.throws(() => validateMessage({
		protocol: NATIVE_SERVER_PROTOCOL,
		kind: 'analyze-response',
		requestId: 'bad-diagnostic',
		language: 'go',
		backend: 'test-backend',
		routes: [],
		diagnostics: [{ code: 'X', severity: 'maybe', file: 'x.go', line: 1, message: 'bad severity' }],
	}), /severity/);
});

test('transport/analyzer boundary: direct responses enforce maxOutputBytes too', () => {
	assert.throws(() => handleAnalyzeRequest(request({
		source: 'package main\nfunc setup(){ r := gin.Default(); r.GET("/this-is-a-long-route-name", handler) }',
		budget: { maxOutputBytes: 120 },
	})), /maxOutputBytes/);
});

test('Rust/Axum: Router turbofish constructors are recognized without type inference', () => {
	const src = `fn app() {
 let app = Router::<AppState>::new().route("/state", get(state));
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => [r.method, r.path, r.handler]), [['GET', '/state', 'state']]);
});

test('Rust mixed-framework file: Axum and Actix facts coexist without cross-talk diagnostics', () => {
	const src = `fn routers() {
 let ax = Router::new().route("/ax", get(ax_handler));
 let act = App::new().route("/act", web::get().to(act_handler));
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => [r.framework, r.method, r.path]), [
		['axum', 'GET', '/ax'],
		['actix-web', 'GET', '/act'],
	]);
	assert.equal(result.diagnostics.length, 0);
	assert.equal(result.framework, 'rust-mixed-http');
});


test('worker: valid NDJSON request crosses a real process boundary and returns validated facts', () => {
	const child = spawnSync(process.execPath, [WORKER], {
		input: encodeNdjson(request({
			requestId: 'worker-go',
			source: 'package main\nfunc setup(){ r := gin.Default(); r.GET("/worker", handler) }',
		})),
		encoding: 'utf8',
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const response = decodeNdjsonLine(child.stdout);
	assert.equal(response.requestId, 'worker-go');
	assert.equal(response.backend, 'go-static-pilot');
	assert.deepEqual(response.routes.map((r) => [r.method, r.path]), [['GET', '/worker']]);
});

test('worker: multi-message stdin is rejected and never executes a second request', () => {
	const input = encodeNdjson(request({ requestId: 'one' })) + encodeNdjson(request({ requestId: 'two' }));
	const child = spawnSync(process.execPath, [WORKER], {
		input,
		encoding: 'utf8',
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 2);
	assert.equal(child.stdout, '');
	assert.match(child.stderr, /exactly one non-empty JSON line/);
});

test('worker: analysis budget failure returns a request-bound error envelope and nonzero exit', () => {
	const child = spawnSync(process.execPath, [WORKER], {
		input: encodeNdjson(request({
			requestId: 'budgeted',
			source: 'package main\nfunc setup(){ r := gin.Default(); r.GET("/a", a) }',
			budget: { maxRoutes: 0 },
		})),
		encoding: 'utf8',
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 2);
	const response = decodeNdjsonLine(child.stdout);
	assert.equal(response.kind, 'error');
	assert.equal(response.requestId, 'budgeted');
	assert.equal(response.code, 'BUDGET_EXCEEDED');
	assert.match(response.message, /maxRoutes/);
});


test('Go/Gin: route-looking text inside quoted data is not executable route syntax', () => {
	const src = String.raw`package main
func setup() {
 note := \`r.GET("/fake", fake)\`
 r := gin.Default()
 r.GET("/real", real)
 _ = note
}`;
	const result = analyzeGoGinSource(src);
	assert.deepEqual(result.routes.map((r) => r.path), ['/real']);
});

test('C#/ASP.NET: route-looking text inside a normal string is not executable route syntax', () => {
	const src = `var fake = "app.MapGet(\\\"/fake\\\", Fake);";
var app = builder.Build();
app.MapGet("/real", Real);`;
	const result = analyzeCSharpAspNetSource(src);
	assert.deepEqual(result.routes.map((r) => r.path), ['/real']);
});

test('native analyzers: identical source produces deep-equal facts on repeated calls', () => {
	const inputs = [
		() => analyzeGoGinSource('package main\nfunc setup(){ r := gin.Default(); r.GET("/x", x) }', { file: 'x.go' }),
		() => analyzeCSharpAspNetSource('var app = builder.Build(); app.MapGet("/x", X);', { file: 'Program.cs' }),
		() => analyzeRustServerSource('fn app(){ let app = Router::new().route("/x", get(x)); }', { file: 'main.rs' }),
	];
	for (const analyze of inputs) assert.deepEqual(analyze(), analyze());
});


test('runner: real worker round-trip returns a request-bound response', () => {
	const response = runNativeServerWorker(request({
		requestId: 'runner-real',
		source: 'package main\nfunc setup(){ r := gin.Default(); r.GET("/runner", handler) }',
		budget: { wallTimeMs: 5_000 },
	}));
	assert.equal(response.requestId, 'runner-real');
	assert.equal(response.language, 'go');
	assert.equal(response.backend, 'go-static-pilot');
	assert.deepEqual(response.routes.map((r) => [r.method, r.path]), [['GET', '/runner']]);
});

test('runner: spawn contract uses absolute Node worker, exact timeout and a secret-minimal environment', () => {
	let observed = null;
	const req = request({ requestId: 'runner-options', budget: { wallTimeMs: 1234 } });
	const spawnFn = (file, args, options) => {
		observed = { file, args, options };
		return {
			status: 0,
			signal: null,
			error: null,
			stderr: '',
			stdout: JSON.stringify({
				protocol: NATIVE_SERVER_PROTOCOL,
				kind: 'analyze-response',
				requestId: req.requestId,
				language: req.language,
				backend: 'fake-test-backend',
				routes: [],
				diagnostics: [],
				groups: [],
				framework: null,
				limitations: [],
			}) + '\n',
		};
	};
	const response = runNativeServerWorker(req, { spawnFn });
	assert.equal(response.backend, 'fake-test-backend');
	assert.equal(observed.file, process.execPath);
	assert.equal(path.basename(observed.args[0]), 'worker.mjs');
	assert.equal(observed.options.timeout, 1234);
	assert.equal(observed.options.windowsHide, true);
	assert.equal(observed.options.shell, false);
	assert.deepEqual(Object.keys(observed.options.env), []);
	assert.equal(Object.getPrototypeOf(observed.options.env), null);
});

test('runner: timeout is a distinct fail-closed error', () => {
	const timedOut = Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' });
	assert.throws(
		() => runNativeServerWorker(request({ requestId: 'runner-timeout', budget: { wallTimeMs: 77 } }), {
			spawnFn: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: timedOut }),
		}),
		(err) => err instanceof NativeWorkerRunError && err.code === 'WORKER_TIMEOUT' && /77/.test(err.message),
	);
});

test('runner: oversized stdout is rejected before response decoding', () => {
	const req = request({ requestId: 'runner-output-limit', budget: { maxOutputBytes: 128 } });
	const spawnFn = () => ({
		status: 0,
		signal: null,
		error: null,
		stderr: '',
		stdout: 'x'.repeat(129),
	});
	assert.throws(
		() => runNativeServerWorker(req, { spawnFn }),
		(err) => err instanceof NativeWorkerRunError
			&& err.code === 'WORKER_OUTPUT_LIMIT'
			&& /maxOutputBytes/.test(err.message),
	);
});

test('runner: a successful process cannot substitute another request response', () => {
	const spawnFn = () => ({
		status: 0,
		signal: null,
		error: null,
		stderr: '',
		stdout: JSON.stringify({
			protocol: NATIVE_SERVER_PROTOCOL,
			kind: 'analyze-response',
			requestId: 'different-request',
			language: 'go',
			backend: 'fake-test-backend',
			routes: [],
			diagnostics: [],
		}) + '\n',
	});
	assert.throws(
		() => runNativeServerWorker(request({ requestId: 'expected-request' }), { spawnFn }),
		(err) => err instanceof NativeWorkerRunError && err.code === 'WORKER_REQUEST_MISMATCH',
	);
});

test('runner: worker-side budget failures remain request-bound structured errors', () => {
	assert.throws(
		() => runNativeServerWorker(request({
			requestId: 'runner-budget',
			source: 'package main\nfunc setup(){ r := gin.Default(); r.GET("/a", a) }',
			budget: { maxRoutes: 0, wallTimeMs: 5_000 },
		})),
		(err) => err instanceof NativeWorkerRunError && err.code === 'BUDGET_EXCEEDED' && /maxRoutes/.test(err.message),
	);
});


test('Rust/Axum: deriving a router by value exposes the final router once, not the consumed base plus final copy', () => {
	const src = `fn app() {
 let api = Router::new().route("/users", get(users));
 let app = api.route("/health", get(health));
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => [r.method, r.path]), [
		['GET', '/users'],
		['GET', '/health'],
	]);
	assert.equal(result.routes.filter((r) => r.path === '/users').length, 1);
});

test('Rust/Axum: merged child routers are consumed roots and do not duplicate their routes', () => {
	const src = `fn app() {
 let users = Router::new().route("/users", get(users_handler));
 let health = Router::new().route("/health", get(health_handler));
 let app = Router::new().merge(users).merge(health);
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => [r.method, r.path]), [
		['GET', '/users'],
		['GET', '/health'],
	]);
	assert.equal(result.routes.length, 2);
});

test('Rust/Axum: unsupported intermediate clone chain is diagnosed rather than treated as a move', () => {
	const src = `fn app() {
 let api = Router::new().route("/users", get(users));
 let cloned = api.clone().route("/health", get(health));
}`;
	const result = analyzeRustServerSource(src);
	assert.deepEqual(result.routes.map((r) => r.path), ['/users']);
	assert.ok(result.diagnostics.some((d) => d.code === 'RUST_AXUM_UNSUPPORTED_BASE_CHAIN'));
});


test('transport: malformed group facts are rejected at the response boundary', () => {
	assert.throws(() => validateMessage({
		protocol: NATIVE_SERVER_PROTOCOL,
		kind: 'analyze-response',
		requestId: 'bad-group',
		language: 'go',
		backend: 'go-static-pilot',
		routes: [],
		diagnostics: [],
		groups: [{
			variable: 'api',
			parent: 'app',
			prefix: 'api',
			path: '/api',
			source: { file: 'main.go', line: 1, index: 0 },
		}],
		framework: 'gin',
		limitations: [],
	}), /group prefix/);
});

test('transport: malformed framework and multiline logical paths are rejected', () => {
	assert.throws(() => validateMessage({
		protocol: NATIVE_SERVER_PROTOCOL,
		kind: 'analyze-response',
		requestId: 'bad-framework',
		language: 'rust',
		backend: 'rust-static-pilot',
		routes: [],
		diagnostics: [],
		groups: [],
		framework: 123,
		limitations: [],
	}), /framework/);
	assert.throws(() => validateMessage(request({ file: 'src/main.go\nforged' })), /single-line logical path/);
});


test('runner: request budgets may narrow but may not expand the default runner profile', () => {
	const narrow = request({
		requestId: 'narrow-budget',
		budget: { wallTimeMs: 5_000, maxOutputBytes: 64 * 1024 },
	});
	const response = runNativeServerWorker(narrow);
	assert.equal(response.requestId, 'narrow-budget');

	assert.throws(
		() => runNativeServerWorker(request({
			requestId: 'expanded-time',
			budget: { wallTimeMs: 60_000 },
		})),
		(err) => err instanceof NativeWorkerRunError && err.code === 'WORKER_BUDGET_EXPANSION' && /wallTimeMs/.test(err.message),
	);
	assert.throws(
		() => runNativeServerWorker(request({
			requestId: 'expanded-output',
			budget: { maxOutputBytes: 8 * 1024 * 1024 },
		})),
		(err) => err instanceof NativeWorkerRunError && err.code === 'WORKER_BUDGET_EXPANSION' && /maxOutputBytes/.test(err.message),
	);
});

test('runner: a trusted profile can explicitly widen one bound while all request bounds remain subordinate', () => {
	const req = request({
		requestId: 'profile-widened',
		budget: { wallTimeMs: 45_000 },
	});
	const spawnFn = (_file, _args, options) => ({
		status: 0,
		signal: null,
		error: null,
		stderr: '',
		stdout: JSON.stringify({
			protocol: NATIVE_SERVER_PROTOCOL,
			kind: 'analyze-response',
			requestId: req.requestId,
			language: req.language,
			backend: 'go-static-pilot',
			routes: [],
			diagnostics: [],
			groups: [],
			framework: null,
			limitations: [],
		}) + '\n',
		observedTimeout: options.timeout,
	});
	const response = runNativeServerWorker(req, {
		spawnFn,
		profileLimits: { wallTimeMs: 60_000 },
	});
	assert.equal(response.requestId, 'profile-widened');
});


test('runner: wider trusted input profile is harmless until a request exceeds worker bootstrap capacity', () => {
	const spawnFn = (_file, _args, options) => {
		const wire = JSON.parse(options.input.trim());
		return {
			status: 0, signal: null, error: null, stderr: '',
			stdout: JSON.stringify({
				protocol: NATIVE_SERVER_PROTOCOL,
				kind: 'analyze-response',
				requestId: wire.requestId,
				language: wire.language,
				backend: 'go-static-pilot',
				routes: [], diagnostics: [], groups: [], framework: null, limitations: [],
			}) + '\n',
		};
	};
	const response = runNativeServerWorker(request({ requestId: 'bootstrap-default' }), {
		spawnFn,
		profileLimits: { maxInputBytes: 8 * 1024 * 1024 },
	});
	assert.equal(response.requestId, 'bootstrap-default');

	assert.throws(
		() => runNativeServerWorker(request({
			requestId: 'bootstrap-expansion',
			budget: { maxInputBytes: 6 * 1024 * 1024 },
		}), {
			spawnFn,
			profileLimits: { maxInputBytes: 8 * 1024 * 1024 },
		}),
		(err) => err instanceof NativeWorkerRunError
			&& err.code === 'WORKER_PROFILE_UNSUPPORTED'
			&& /maxInputBytes/.test(err.message),
	);
});

test('runner: omitted request budget fields are clamped to a narrower trusted profile', () => {
	let observed = null;
	const req = request({ requestId: 'profile-clamp' });
	const spawnFn = (_file, _args, options) => {
		const wire = JSON.parse(options.input.trim());
		observed = { timeout: options.timeout, budget: wire.budget };
		return {
			status: 0, signal: null, error: null, stderr: '',
			stdout: JSON.stringify({
				protocol: NATIVE_SERVER_PROTOCOL,
				kind: 'analyze-response',
				requestId: wire.requestId,
				language: wire.language,
				backend: 'go-static-pilot',
				routes: [], diagnostics: [], groups: [], framework: null, limitations: [],
			}) + '\n',
		};
	};
	runNativeServerWorker(req, {
		spawnFn,
		profileLimits: {
			wallTimeMs: 2_000,
			maxOutputBytes: 32 * 1024,
			maxRoutes: 50,
			maxDiagnostics: 25,
		},
	});
	assert.equal(observed.timeout, 2_000);
	assert.equal(observed.budget.wallTimeMs, 2_000);
	assert.equal(observed.budget.maxOutputBytes, 32 * 1024);
	assert.equal(observed.budget.maxRoutes, 50);
	assert.equal(observed.budget.maxDiagnostics, 25);
});


test('batch: input file order does not change aggregated Go facts', () => {
	const a = { file: 'api/users.go', source: 'package api\nfunc setup(){ r := gin.Default(); r.GET("/users", listUsers) }' };
	const b = { file: 'api/health.go', source: 'package api\nfunc setup(){ r := gin.Default(); r.GET("/health", health) }' };
	const left = analyzeNativeServerFiles({ language: 'go', files: [a, b] });
	const right = analyzeNativeServerFiles({ language: 'go', files: [b, a] });
	assert.deepEqual(left, right);
	assert.deepEqual(left.routes.map((r) => [r.source.file, r.method, r.path]), [
		['api/health.go', 'GET', '/health'],
		['api/users.go', 'GET', '/users'],
	]);
});

test('batch: duplicate method/path facts across files are preserved for later reconciliation', () => {
	const result = analyzeNativeServerFiles({
		language: 'csharp',
		files: [
			{ file: 'A.cs', source: 'var app = builder.Build(); app.MapGet("/same", A);' },
			{ file: 'B.cs', source: 'var app = builder.Build(); app.MapGet("/same", B);' },
		],
	});
	assert.equal(result.routes.length, 2);
	assert.deepEqual(result.routes.map((r) => r.source.file), ['A.cs', 'B.cs']);
});

test('batch: diagnostics remain source-file scoped and deterministically ordered', () => {
	const result = analyzeNativeServerFiles({
		language: 'rust',
		files: [
			{ file: 'z.rs', source: 'fn app(){ let app = Router::new().route(path(), get(z)); }' },
			{ file: 'a.rs', source: 'fn app(){ let app = Router::new().route(other(), get(a)); }' },
		],
	});
	assert.deepEqual(result.diagnostics.map((d) => [d.file, d.code]), [
		['a.rs', 'RUST_AXUM_DYNAMIC_ROUTE_PATH'],
		['z.rs', 'RUST_AXUM_DYNAMIC_ROUTE_PATH'],
	]);
});

test('batch: duplicate logical file paths are rejected instead of merged', () => {
	assert.throws(() => analyzeNativeServerFiles({
		language: 'go',
		files: [
			{ file: 'main.go', source: 'package main' },
			{ file: 'main.go', source: 'package main' },
		],
	}), /duplicate batch logical path/);
});

test('batch: caller may narrow but not widen file and byte ceilings', () => {
	assert.throws(() => analyzeNativeServerFiles({
		language: 'go',
		files: [
			{ file: 'a.go', source: 'package a' },
			{ file: 'b.go', source: 'package b' },
		],
		limits: { maxFiles: 1 },
	}), /maxFiles/);
	assert.throws(() => analyzeNativeServerFiles({
		language: 'go',
		files: [{ file: 'a.go', source: 'x'.repeat(128) }],
		limits: { maxTotalBytes: 64 },
	}), /maxTotalBytes/);
	assert.throws(() => analyzeNativeServerFiles({
		language: 'go',
		files: [{ file: 'a.go', source: 'package a' }],
		limits: { maxFiles: 4097 },
	}), /maxFiles/);
});

test('batch: unsupported languages and multiline logical paths fail closed', () => {
	assert.throws(() => analyzeNativeServerFiles({
		language: 'swift',
		files: [{ file: 'main.swift', source: 'print("hello")' }],
	}), /not implemented/);
	assert.throws(() => analyzeNativeServerFiles({
		language: 'go',
		files: [{ file: 'a.go\nforged', source: 'package a' }],
	}), /single-line logical path/);
});
