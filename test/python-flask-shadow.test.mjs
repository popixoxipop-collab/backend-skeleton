import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFiles, findPythonRuntime } from '../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts } from '../scanners/language/python/resolver.mjs';
import { buildFlaskRouteShadow } from '../scanners/language/python/flask-shadow.mjs';

const runtime = findPythonRuntime();

function project(root, files) {
  const batch = analyzePythonFiles({ repoRoot: root, files });
  assert.equal(batch.ok, true, JSON.stringify(batch, null, 2));
  return buildPythonProjectFacts(batch.results);
}

test('T06 Flask shadow records literal blueprint prefixes and explicit route methods', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-flask-shadow-'));
  fs.writeFileSync(path.join(root, 'api.py'), `
from flask import Blueprint
bp = Blueprint("api", __name__, url_prefix="/api")

@bp.get("/items")
def list_items():
    pass

@bp.route("/items", methods=["POST", "PATCH"])
def mutate_item():
    pass
`);
  const shadow = buildFlaskRouteShadow(project(root, ['api.py']));
  assert.equal(shadow.unknowns.length, 0, JSON.stringify(shadow, null, 2));
  assert.equal(shadow.registrations.length, 2);
  const byFn = Object.fromEntries(shadow.registrations.map((x) => [x.function, x]));
  assert.equal(byFn.list_items.path, '/api/items');
  assert.deepEqual(byFn.list_items.methods, ['GET']);
  assert.equal(byFn.list_items.methodsStatus, 'explicit-decorator');
  assert.deepEqual(byFn.mutate_item.methods, ['PATCH', 'POST']);
  assert.equal(byFn.mutate_item.methodsStatus, 'explicit-methods-list');
});

test('T06 Flask shadow does not silently turn @app.route() into GET semantics', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-flask-defaults-'));
  fs.writeFileSync(path.join(root, 'app.py'), `
from flask import Flask
app = Flask(__name__)
@app.route("/health")
def health():
    pass
`);
  const shadow = buildFlaskRouteShadow(project(root, ['app.py']));
  assert.equal(shadow.unknowns.length, 0, JSON.stringify(shadow, null, 2));
  assert.deepEqual(shadow.registrations[0].methods, []);
  assert.equal(shadow.registrations[0].methodsStatus, 'framework-default-unresolved');
});

test('T06 Flask shadow abstains when blueprint prefix or methods are dynamic', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-flask-unknown-'));
  fs.writeFileSync(path.join(root, 'app.py'), `
from flask import Blueprint
PREFIX = make_prefix()
METHODS = load_methods()
bp = Blueprint("api", __name__, url_prefix=PREFIX)
@bp.route("/items", methods=METHODS)
def items():
    pass
`);
  const shadow = buildFlaskRouteShadow(project(root, ['app.py']));
  assert.equal(shadow.registrations.length, 0);
  assert.ok(shadow.unknowns.some((x) => x.reason === 'blueprint-prefix-not-literal'));
});

test('T06 Flask shadow leaves imported or factory-provided route receivers unresolved', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-flask-receiver-'));
  fs.writeFileSync(path.join(root, 'app.py'), `
@app.get("/health")
def health():
    pass
`);
  const shadow = buildFlaskRouteShadow(project(root, ['app.py']));
  assert.equal(shadow.registrations.length, 0);
  assert.ok(shadow.unknowns.some((x) => x.reason === 'route-receiver-not-locally-declared'));
});
