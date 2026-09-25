import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapter, detectCSharpAspNetCoreRoot, scanCSharpAspNetCore } from '../scanners/adapters/csharp-aspnet-core.mjs';

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture({ web = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-aspnet-'));
  write(root, 'Api.csproj', web
    ? '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    : '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  write(root, 'Program.cs', [
    'var builder = WebApplication.CreateBuilder(args);',
    'builder.Services.AddControllers();',
    'var app = builder.Build();',
    'app.MapControllers();',
    'app.MapGet("/health", Health);',
    'var api = app.MapGroup("/api");',
    'var admin = api.MapGroup("/admin");',
    'api.MapPost("/users", CreateUser);',
    'admin.MapDelete("/users/{id}", (int id) => Results.NoContent());',
    'app.MapGet(dynamicPath, DynamicHandler);',
    ''
  ].join('\n'));
  write(root, 'Controllers/WidgetsController.cs', [
    'using Microsoft.AspNetCore.Mvc;',
    '[ApiController]',
    '[Route("api/[controller]")]',
    'public class WidgetsController : ControllerBase',
    '{',
    '    [HttpGet("{id}")]',
    '    public IActionResult GetWidget(int id) => Ok();',
    '',
    '    [HttpPost]',
    '    [Authorize]',
    '    public IActionResult CreateWidget() => Ok();',
    '',
    '    [HttpDelete("/ops/widgets/{id}")]',
    '    public IActionResult DeleteWidget(int id) => NoContent();',
    '}',
    ''
  ].join('\n'));
  return root;
}

test('detectCSharpAspNetCoreRoot requires a Web SDK project plus ASP.NET source signal', () => {
  const root = fixture();
  assert.equal(detectCSharpAspNetCoreRoot(root), root);
  const nonWeb = fixture({ web: false });
  assert.equal(detectCSharpAspNetCoreRoot(nonWeb), null);
});

test('attribute-routed controllers combine class and action templates with route-token replacement', () => {
  const root = fixture();
  const report = scanCSharpAspNetCore(root, root);
  const widgets = report.modules.find((m) => m.module === 'widgets');
  assert.ok(widgets);
  const endpoints = widgets.controllers[0].endpoints;
  assert.ok(endpoints.some((e) => e.verb === 'GET' && e.path === '/api/Widgets/{id}' && e.method === 'GetWidget'));
  assert.ok(endpoints.some((e) => e.verb === 'POST' && e.path === '/api/Widgets' && e.method === 'CreateWidget'));
  assert.ok(endpoints.some((e) => e.verb === 'DELETE' && e.path === '/ops/widgets/{id}' && e.method === 'DeleteWidget'));
});

test('Minimal API MapGroup prefixes compose through nested groups', () => {
  const root = fixture();
  const report = scanCSharpAspNetCore(root, root);
  const endpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
  assert.ok(endpoints.some((e) => e.verb === 'GET' && e.path === '/health' && e.method === 'Health'));
  assert.ok(endpoints.some((e) => e.verb === 'POST' && e.path === '/api/users' && e.method === 'CreateUser'));
  assert.ok(endpoints.some((e) => e.verb === 'DELETE' && e.path === '/api/admin/users/{id}' && e.method === null));
});

test('computed Minimal API paths are skipped instead of guessed', () => {
  const root = fixture();
  const report = scanCSharpAspNetCore(root, root);
  const endpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
  assert.equal(endpoints.some((e) => e.method === 'DynamicHandler'), false);
});

test('first ASP.NET Core slice keeps operation/schema/persistence/codegen capabilities off', () => {
  assert.equal(adapter.id, 'csharp-aspnet-core');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});
