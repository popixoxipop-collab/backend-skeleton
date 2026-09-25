import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	NATIVE_SERVER_PROTOCOL,
	analyzeCSharpAspNetSource,
	analyzeGoGinSource,
	decodeNdjsonLine,
	encodeNdjson,
	handleAnalyzeRequest,
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
