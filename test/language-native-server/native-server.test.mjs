import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	NATIVE_SERVER_PROTOCOL,
	analyzeCSharpAspNetSource,
	analyzeGoGinSource,
	analyzeRustServerSource,
	decodeNdjsonLine,
	encodeNdjson,
	handleAnalyzeRequest,
	validateMessage,
} from '../../scanners/language/native-server/index.mjs';

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
