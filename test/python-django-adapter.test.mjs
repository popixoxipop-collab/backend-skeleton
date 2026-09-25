import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adapter,
  detectPythonDjangoRoot,
  scanPythonDjango,
} from '../scanners/adapters/python-django.mjs';

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture({ django = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-django-'));
  write(root, 'requirements.txt', django ? 'Django==5.2.6\ndjangorestframework==3.16.1\n' : 'Flask==3.1.2\n');

  write(root, 'api/views.py', [
    'from rest_framework import viewsets',
    'from rest_framework.decorators import action',
    '',
    'class UserViewSet(viewsets.ModelViewSet):',
    "    @action(detail=True, methods=['post'], url_path='set-password')",
    '    def set_password(self, request, pk=None):',
    '        pass',
    '',
    'class AuditViewSet(viewsets.ReadOnlyModelViewSet):',
    '    pass',
    '',
    'class SlugViewSet(viewsets.ModelViewSet):',
    "    lookup_field = 'slug'",
    ''
  ].join('\n'));

  write(root, 'api/urls.py', [
    'from django.urls import include, path',
    'from rest_framework.routers import DefaultRouter',
    'from .views import UserViewSet, AuditViewSet',
    '',
    'router = DefaultRouter()',
    "router.register(r'users', UserViewSet, basename='user')",
    "router.register(r'audit', AuditViewSet, basename='audit')",
    "router.register(r'slugs', SlugViewSet, basename='slug')",
    "urlpatterns = [path('api/', include(router.urls))]",
    ''
  ].join('\n'));
  return root;
}

test('detectPythonDjangoRoot requires Django dependency plus URL/DRF source signal', () => {
  const root = fixture();
  assert.equal(detectPythonDjangoRoot(root), root);
  const other = fixture({ django: false });
  assert.equal(detectPythonDjangoRoot(other), null);
});

test('ModelViewSet router registration expands only the documented standard HTTP actions', () => {
  const root = fixture();
  const report = scanPythonDjango(root, root);
  const mod = report.modules.find((m) => m.module === 'api');
  assert.ok(mod);
  const user = mod.controllers.find((c) => c.className === 'UserViewSet');
  assert.ok(user);
  const byPath = new Map();
  for (const ep of user.endpoints) {
    if (!byPath.has(ep.path)) byPath.set(ep.path, []);
    byPath.get(ep.path).push(ep.verb);
  }
  assert.deepEqual(byPath.get('/api/users/').sort(), ['GET', 'POST']);
  assert.deepEqual(byPath.get('/api/users/{pk}/').sort(), ['DELETE', 'GET', 'PATCH', 'PUT']);
});

test('@action(detail=True, methods=[post]) produces the scoped extra route', () => {
  const root = fixture();
  const report = scanPythonDjango(root, root);
  const endpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
  assert.ok(endpoints.some((e) => e.verb === 'POST' && e.path === '/api/users/{pk}/set-password/' && e.method === 'set_password'));
});

test('ReadOnlyModelViewSet does not invent write routes', () => {
  const root = fixture();
  const report = scanPythonDjango(root, root);
  const audit = report.modules[0].controllers.find((c) => c.className === 'AuditViewSet');
  assert.deepEqual(audit.endpoints.map((e) => e.verb).sort(), ['GET', 'GET']);
  assert.equal(audit.endpoints.some((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.verb)), false);
});

test('custom DRF lookup configuration suppresses unverified detail-route synthesis', () => {
  const root = fixture();
  const report = scanPythonDjango(root, root);
  const slug = report.modules[0].controllers.find((c) => c.className === 'SlugViewSet');
  assert.ok(slug);
  assert.deepEqual(slug.endpoints.map((e) => [e.verb, e.path]).sort(), [
    ['GET', '/api/slugs/'],
    ['POST', '/api/slugs/'],
  ]);
  assert.equal(slug.endpoints.some((e) => e.path.includes('{pk}')), false);
});

test('duplicate ViewSet class names across files are treated as ambiguous instead of last-one-wins', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'api', 'other_views.py'), [
    'from rest_framework import viewsets',
    'class UserViewSet(viewsets.ReadOnlyModelViewSet):',
    '    pass',
    ''
  ].join('\n'));
  const report = scanPythonDjango(root, root);
  const controllers = report.modules.flatMap((m) => m.controllers);
  assert.equal(controllers.some((c) => c.className === 'UserViewSet'), false);
  assert.ok(controllers.some((c) => c.className === 'AuditViewSet'));
});

test('first Django/DRF slice keeps operation/schema/persistence/codegen capabilities off', () => {
  assert.equal(adapter.id, 'python-django');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});
