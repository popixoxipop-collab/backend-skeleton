#!/usr/bin/env node
// P3b: the other half of the java-compile-smoke.mjs precedent -- proof that `bskel handles emit`'s
// generated Python actually IMPORTS, not just parses. test/python-fastapi-handles.test.mjs used to
// assert this with `ast.parse` (syntax-only) -- that check can't catch a real API mismatch (e.g. a
// generated `from {{SESSION_DEP_MODULE}} import {{SESSION_DEP_NAME}}` pointing at a name that
// doesn't actually exist), confirmed live during this item's own grounding: renaming the fixture's
// `SessionDep` to something else leaves `ast.parse` green but makes a real `import` raise
// `ImportError` at exactly the line a real consumer's app would hit it. Runs the full gated
// workflow against test/fixtures/python-fastapi/ in a scratch copy, same shape as
// java-compile-smoke.mjs, then pip-installs fastapi+sqlmodel into a throwaway venv (no compiler
// toolchain needed -- catalog's own "marginal cost" framing, confirmed live: <10s with warm pip
// cache) and imports every generated module for real.
//
// Requires `python3` on PATH (already a hard requirement for test/handles-python-codec.test.mjs --
// see D-handles-providers in DECISIONS.md for why that one is non-skippable too).
//
// D-runtime-conformance-receipts: also runs `observe emit` and real-imports its generated modules
// (observe_contract.py/contract_check.py/observed_schema.py), proving the headline python-specific
// correctness requirement live -- a decorated `async def` function must return the real awaited
// value, not an unawaited coroutine object -- plus a property battery proving no violation message
// ever embeds an observed value (Decision A's own safety invariant).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'python-fastapi');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const FEATURE_ID = '001-item-management';

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function fail(message) {
	console.error(`python-import-smoke: FAIL -- ${message}`);
	process.exit(1);
}

console.log('python-import-smoke: copying fixture to a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-import-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.venv/\n');

// D-runtime-conformance-receipts: this fixture's own scanned operationId is always null
// (D-fastapi-adapter) and it declares no global path prefix at all -- contracts/openapi.mjs's own
// reconcileModule() cannot resolve ANY endpoint via --openapi-file without either a real anchor
// operationId to auto-infer a prefix from, or an explicit non-empty --path-prefix (confirmed live:
// PATH_PREFIX_RE rejects an empty string, so "no prefix" genuinely cannot be expressed). Added
// here, to the SCRATCH copy only (never the committed fixture other tests share), matching the
// exact main.py/core/config.py shape test/observe-emit-python-cli.test.mjs's own fixture already
// proves works.
fs.mkdirSync(path.join(scratch, 'backend', 'app', 'core'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'backend', 'app', 'core', 'config.py'), 'class Settings:\n    API_V1_STR: str = "/api/v1"\n\nsettings = Settings()\n');
fs.writeFileSync(path.join(scratch, 'backend', 'app', 'main.py'), `
from fastapi import FastAPI
from app.api.items import router
from app.core.config import settings

app = FastAPI()
app.include_router(router, prefix=settings.API_V1_STR)
`);

sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: python-import-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-import-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

console.log('python-import-smoke: preflight -> feature init -> scan -> disposition -> handles emit...');
let r = bskel(['preflight'], scratch);
if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);

r = bskel(['feature', 'init', '--slug', 'item-management'], scratch);
if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

r = bskel(['scan', '--feature', FEATURE_ID, '--terms', 'item'], scratch);
if (![0, 3].includes(r.code)) fail(`scan: exit ${r.code}: ${r.stderr || r.stdout}`);

r = bskel(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'extend', '--note', 'python-import-smoke'], scratch);
if (r.code !== 0) fail(`scan disposition: ${r.stderr || r.stdout}`);

// D-runtime-conformance-receipts: a real contract (not just a force-passed gate) is required here
// -- unlike `handles emit` (which only needs plan(), not contract.operations), `observe emit` calls
// loadContract() directly. D-fastapi-adapter: this scanner's operationId is always null, so a real
// --openapi-file is the only way to get one, matching test/python-fastapi-handles.test.mjs's own
// D-resolver-policy-split regression test.
const openApiPath = path.join(scratch, 'openapi.json');
fs.writeFileSync(openApiPath, JSON.stringify({
	openapi: '3.1.0',
	paths: { '/api/v1/items/{id}': { get: { operationId: 'items-read_item', responses: {} } } },
}));
r = bskel(['contract', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--openapi-file', openApiPath, '--path-prefix', '/api/v1'], scratch);
if (r.code !== 0) fail(`contract emit: ${r.stderr || r.stdout}`);

r = bskel(['handles', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--json'], scratch);
if (r.code !== 0) fail(`handles emit: ${r.stderr || r.stdout}`);
let emitResult;
try {
	emitResult = JSON.parse(r.stdout);
} catch {
	fail(`handles emit produced no parseable JSON: ${r.stdout}`);
}
if (!emitResult.written.includes('backend/app/handles/resolvers/item.py')) {
	fail(`expected backend/app/handles/resolvers/item.py to be written -- got ${JSON.stringify(emitResult.written)}`);
}
// G4 follow-up (D-handles-providers): migration.sql is now a real spec output, mirroring
// java-spring's own O4 work.
if (!emitResult.written.includes('specs/001-item-management/handles/migration.sql')) {
	fail(`expected specs/001-item-management/handles/migration.sql to be written -- got ${JSON.stringify(emitResult.written)}`);
}

console.log('python-import-smoke: observe emit --module items...');
r = bskel(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--json'], scratch);
if (r.code !== 0) fail(`observe emit: ${r.stderr || r.stdout}`);
let observeResult;
try {
	observeResult = JSON.parse(r.stdout);
} catch {
	fail(`observe emit produced no parseable JSON: ${r.stdout}`);
}
if (!observeResult.written.includes('backend/app/observe/observe_contract.py')) {
	fail(`expected backend/app/observe/observe_contract.py to be written -- got ${JSON.stringify(observeResult.written)}`);
}

console.log('python-import-smoke: creating a throwaway venv and installing fastapi + sqlmodel...');
const backendDir = path.join(scratch, 'backend');
try {
	sh('python3', ['-m', 'venv', '.venv'], scratch, { quiet: true });
} catch (err) {
	fail(`could not create a venv -- is \`python3\` on PATH with the venv module available? (${err.message})`);
}
const venvPython = path.join(scratch, '.venv', 'bin', 'python');
try {
	sh(venvPython, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'fastapi', 'sqlmodel'], scratch, { quiet: true });
} catch (err) {
	fail(`pip install fastapi sqlmodel failed: ${err.stderr || err.message}`);
}

// A small, test-only driver (not a generated artifact) -- imports every generated module for real,
// with PYTHONPATH set to the detected import root (backend/), the same way a real consumer's app
// would run it. Unlike ast.parse, this actually executes each module's top-level code, including
// every `from X import Y` -- catching a real name/API mismatch, not just a syntax error.
const DRIVER_SOURCE = `
import asyncio
import app.handles.codec
import app.handles.registry
import app.handles.router
import app.handles.resolvers.item
import app.handles.tables
import app.handles.handle_service
import app.handles.record_snapshot
import app.observe.observe_contract
import app.observe.contract_check
import app.observe.observed_schema
from app.observe.observe_contract import observe_contract
from app.models import Item, ItemPublic

assert app.handles.registry.resolver_for("Item") is not None, "Item resolver did not register itself on import"
assert any(rt.path == "/handles/{handle}" for rt in app.handles.router.router.routes), "router.py did not wire the expected /handles/{handle} route"
# G4 follow-up (D-handles-providers): real recover() lifecycle, mirroring java-spring's own O4.
assert any(rt.path == "/handles/{handle}/recover" for rt in app.handles.router.router.routes), "router.py did not wire the expected /handles/{handle}/recover route"
assert app.handles.tables.HandleRegistry.__tablename__ == "sbf_handle"
assert app.handles.tables.HandleSnapshot.__tablename__ == "sbf_handle_snapshot"
assert callable(app.handles.record_snapshot.record_snapshot)
assert app.observe.observed_schema.get("items-read_item") is not None, "observed_schema.py did not load the emitted observed-schema.json"

# D-runtime-conformance-receipts: the headline python-specific correctness requirement -- a single
# wrapper naively calling an async function without awaiting it would return an unawaited coroutine
# object as the "result", corrupting a real HTTP response. Proves the real generated decorator
# dispatches to a genuinely separate async wrapper (real value returned, not a coroutine) for an
# operationId the observed schema does NOT know about (the early-return-before-await path is
# exactly where a naive single-wrapper bug would first manifest).
@observe_contract(operation_id="nonexistent-operation-for-smoke-test")
async def _async_probe(x: str) -> dict:
    return {"x": x}

async_result = asyncio.run(_async_probe("hello"))
assert async_result == {"x": "hello"}, f"async wrapper did not return the real awaited value -- got {async_result!r} (a coroutine object here would mean the headline async-wrapper fix regressed)"

@observe_contract(operation_id="nonexistent-operation-for-smoke-test")
def _sync_probe(x: str) -> dict:
    return {"x": x}

sync_result = _sync_probe("hello")
assert sync_result == {"x": "hello"}, f"sync wrapper did not return the real value -- got {sync_result!r}"

# D-runtime-conformance-receipts, Decision A's own safety invariant: no violation message, across a
# battery of deliberately identifying bad inputs, may ever embed the observed value itself -- a real
# payload value must never leave this process, structurally, not by convention.
import re

check = app.observe.contract_check
MARKER = "SECRET_MARKER_VALUE_12345"
# pattern is an ALREADY-COMPILED re.Pattern in the real generated data (observed_schema.py's own
# _compile_property() compiles it once at load time) -- matching that shape exactly here, not a
# raw string, since contract_check.py's own _check_scalar() calls .match() on it directly.
schema = {"required": ["field"], "properties": {"field": {"type": "string", "pattern": re.compile(r"^[0-9]+$")}}, "unsupported": []}
battery = [
    {},
    {"field": MARKER},
    {"field": 12345, "other": MARKER},
    None,
    MARKER,
]
for actual in battery:
    violations = check.check_object(schema, actual, "/body")
    for v in violations:
        assert MARKER not in v.message, f"violation message embedded the observed value! actual={actual!r} message={v.message!r}"
path_params_schema = {"required": ["id"], "properties": {"id": {"type": "string", "pattern": re.compile(r"^[0-9a-f-]+$")}}, "unsupported": []}
for actual in [{}, {"id": MARKER}]:
    violations = check.check_path_params(path_params_schema, actual)
    for v in violations:
        assert MARKER not in v.message, f"path-param violation message embedded the observed value! actual={actual!r} message={v.message!r}"

print("python-import-smoke: all generated modules imported successfully")
`;

console.log('python-import-smoke: importing every generated module for real (not just ast.parse)...');
try {
	sh(venvPython, ['-c', DRIVER_SOURCE], backendDir, { quiet: true, env: { ...process.env, PYTHONPATH: backendDir } });
} catch (err) {
	fail(`real import of generated modules failed:\n${err.stderr || err.stdout || err.message}`);
}

console.log('python-import-smoke: PASS -- generated Python imported cleanly against real fastapi + sqlmodel.');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
