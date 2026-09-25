import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adapter,
  detectPythonFlaskRoot,
  scanPythonFlask,
} from '../scanners/adapters/python-flask.mjs';

function fixture({ flask = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-flask-'));
  fs.writeFileSync(path.join(root, 'requirements.txt'), flask ? 'Flask==3.1.2\n' : 'fastapi==0.118.0\n');
  fs.writeFileSync(path.join(root, 'app.py'), [
    'from flask import Flask, Blueprint',
    'app = Flask(__name__)',
    "bp = Blueprint('users', __name__, url_prefix='/users')",
    "app.register_blueprint(bp)",
    '',
    "@app.get('/health')",
    'def health():',
    '    return {}',
    '',
    "@app.route('/items/<int:item_id>', methods=['GET', 'POST'])",
    '@auth_required()',
    'def item(item_id):',
    '    return {}',
    '',
    "@bp.route('/<int:user_id>', methods=['GET'])",
    'def user(user_id):',
    '    return {}',
    '',
    "@app.route(dynamic_path)",
    'def dynamic():',
    '    return {}',
    '',
    '"""',
    "@app.get('/phantom')",
    'def phantom(): pass',
    '"""',
    ''
  ].join('\n'));
  return root;
}

test('detectPythonFlaskRoot requires a Flask dependency and source-confirmed Flask/Blueprint construction', () => {
  const root = fixture();
  assert.equal(detectPythonFlaskRoot(root), root);
  const other = fixture({ flask: false });
  assert.equal(detectPythonFlaskRoot(other), null);
});

test('scanPythonFlask extracts app shortcut and route(methods=...) endpoints', () => {
  const root = fixture();
  const report = scanPythonFlask(root, root);
  const mod = report.modules.find((m) => m.module === 'app');
  assert.ok(mod);
  const endpoints = mod.controllers.flatMap((c) => c.endpoints);
  assert.deepEqual(
    endpoints.filter((e) => e.path === '/health').map((e) => [e.verb, e.method]),
    [['GET', 'health']]
  );
  assert.deepEqual(
    endpoints.filter((e) => e.path === '/items/<int:item_id>').map((e) => e.verb).sort(),
    ['GET', 'POST']
  );
});

test('same-file Blueprint registration composes its literal default url_prefix', () => {
  const root = fixture();
  const report = scanPythonFlask(root, root);
  const endpoints = report.modules[0].controllers.flatMap((c) => c.endpoints);
  assert.ok(endpoints.some((e) => e.path === '/users/<int:user_id>' && e.verb === 'GET'));
});

test('computed paths and docstring/comment-like phantom routes are skipped', () => {
  const root = fixture();
  const report = scanPythonFlask(root, root);
  const endpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
  assert.equal(endpoints.some((e) => e.method === 'dynamic'), false);
  assert.equal(endpoints.some((e) => e.path.includes('phantom')), false);
});

test('first Flask slice declares unsupported schema/persistence/codegen capabilities honestly', () => {
  assert.equal(adapter.id, 'python-flask');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});
