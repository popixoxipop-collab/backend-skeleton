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
import { bskel, makeFail, establishThroughContract, REPO_ROOT } from './_smoke-lib.mjs';
import { generateKeypair, verifyPayload } from '../lib/attest.mjs';

const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'python-fastapi');
const FEATURE_ID = '001-item-management';

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

const fail = makeFail('python-import-smoke');

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

console.log('python-import-smoke: preflight -> feature init -> scan -> disposition -> contract emit -> cross-feature-check -> handles emit...');
// D-runtime-conformance-receipts: a real contract (not just a force-passed gate) is required here
// -- unlike `handles emit` (which only needs plan(), not contract.operations), `observe emit` calls
// loadContract() directly. D-fastapi-adapter: this scanner's operationId is always null, so a real
// --openapi-file is the only way to get one, matching test/python-fastapi-handles.test.mjs's own
// D-resolver-policy-split regression test.
const openApiPath = path.join(scratch, 'openapi.json');
establishThroughContract(scratch, fail, {
	featureId: FEATURE_ID, slug: 'item-management', terms: 'item', mode: 'extend', note: 'python-import-smoke',
	// D-cli-contract convention: openapi.json is written AFTER preflight, not before -- an
	// untracked file at repo root would otherwise make preflight's own dirty-tree check fail.
	// establishThroughContract's beforeContractStep hook exists for exactly this ordering need.
	// D-business-rules (R9): a requestBody attached to this GET operation purely so the rules
	// phase below has real, contract-declared fields to author rules against -- not a realistic
	// REST shape, deliberately kept minimal rather than adding a whole new scratch-only route file
	// (the rules phase constructs payloads directly, the same simplification
	// scripts/java-compile-smoke.mjs's own business-rules phase already uses).
	beforeContractStep: () => fs.writeFileSync(openApiPath, JSON.stringify({
		openapi: '3.1.0',
		paths: {
			'/api/v1/items/{id}': {
				get: {
					operationId: 'items-read_item',
					responses: {},
					requestBody: {
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										capacity: { type: 'integer' },
										ownerName: { type: 'string' },
										status: { type: 'string', enum: ['draft', 'published', 'archived'] },
										startWindow: { type: 'string' },
										endWindow: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
	})),
	contractStep: { kind: 'emit', args: ['--module', 'items', '--openapi-file', openApiPath, '--path-prefix', '/api/v1'] },
});

let r = bskel(['handles', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--json'], scratch);
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

// D-business-rules (R9): real rules against the requestBody attached to items-read_item above.
console.log('python-import-smoke: rules check -> rules emit --module items...');
fs.writeFileSync(path.join(scratch, 'specs', FEATURE_ID, 'rules.yaml'), `schema: sbf.feature-rules-source/1
rules:
  - id: capacity-cap
    kind: field
    operation: items-read_item
    pointer: /capacity
    assert: maximum
    value: 500
    reason: python-import-smoke
  - id: owner-min
    kind: field
    operation: items-read_item
    pointer: /ownerName
    assert: minLength
    value: 3
    reason: python-import-smoke
  - id: window-order
    kind: cross
    operation: items-read_item
    pointers: [/startWindow, /endWindow]
    assert: lt
    reason: python-import-smoke
  - id: publish-flow
    kind: transition
    operation: items-read_item
    pointer: /status
    from: [draft]
    to: [published]
    reason: python-import-smoke
`);
r = bskel(['rules', 'check', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`rules check: ${r.stderr || r.stdout}`);
r = bskel(['rules', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--json'], scratch);
if (r.code !== 0) fail(`rules emit: ${r.stderr || r.stdout}`);
let rulesEmitResult;
try {
	rulesEmitResult = JSON.parse(r.stdout);
} catch {
	fail(`rules emit produced no parseable JSON: ${r.stdout}`);
}
if (!rulesEmitResult.written.includes('backend/app/rules/enforce_rules.py')) {
	fail(`expected backend/app/rules/enforce_rules.py to be written -- got ${JSON.stringify(rulesEmitResult.written)}`);
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
	// D-runtime-conformance-receipts (cryptographic receipt attestation): `cryptography` -- receipt_
	// sign.py's own real (not stdlib) Ed25519 dependency, a genuinely new category of dependency for
	// this provider's generated runtime code. Installed unconditionally here since this script's
	// whole job is proving the real import graph works, including the lazily-imported signing path.
	sh(venvPython, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'fastapi', 'sqlmodel', 'cryptography'], scratch, { quiet: true });
} catch (err) {
	fail(`pip install fastapi sqlmodel cryptography failed: ${err.stderr || err.message}`);
}

// A small, test-only driver (not a generated artifact) -- imports every generated module for real,
// with PYTHONPATH set to the detected import root (backend/), the same way a real consumer's app
// would run it. Unlike ast.parse, this actually executes each module's top-level code, including
// every `from X import Y` -- catching a real name/API mismatch, not just a syntax error.
const DRIVER_SOURCE = `
import asyncio
import os
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
import app.observe.receipt_sign
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

# D-business-rules (R9): real generated rule_check/rule_set against the 4 authored rules (2 field,
# 1 cross, 1 transition) -- the pure-executor proof, mirroring java-compile-smoke.mjs's own
# RuleExecSmokeTest exactly.
import app.rules.rule_check as rule_check
import app.rules.rule_set as rule_set
from app.rules.enforce_rules import enforce_rules

rules = rule_set.for_operation("items-read_item")
assert rules["field"] and rules["cross"] and rules["transition"], f"expected all three predicate kinds compiled, got {rules}"

violating_body = {"capacity": 999, "ownerName": "x", "startWindow": "2026-01-02", "endWindow": "2026-01-01"}
violating = list(rule_check.check(rules, violating_body))
violating += list(rule_check.check_transitions(rules, {"status": "published"}, {"/status": "archived"}))
assert len(violating) == 4, f"expected 4 violations (capacity-cap, owner-min, window-order, publish-flow), got {len(violating)}: {[v.rule_id for v in violating]}"
assert sorted(v.rule_id for v in violating) == sorted(["capacity-cap", "owner-min", "window-order", "publish-flow"]), f"got {[v.rule_id for v in violating]}"

valid_body = {"capacity": 100, "ownerName": "widget-owner", "startWindow": "2026-01-01", "endWindow": "2026-01-02"}
valid = list(rule_check.check(rules, valid_body))
valid += list(rule_check.check_transitions(rules, {"status": "published"}, {"/status": "draft"}))
assert len(valid) == 0, f"expected 0 violations against a payload deliberately constructed to satisfy every rule, got {len(valid)}: {[v.rule_id for v in valid]}"

# D-business-rules (R8): the @enforce_rules decorator itself -- observe mode always proceeds,
# enforce mode rejects with HTTP 400 before the wrapped function runs and never leaks an observed
# value, a valid payload always proceeds even in enforce mode, and an operation with no rules is a
# silent no-op. Toggled via the real BSKEL_RULES_MODE environment variable, matching how a real
# deployment would switch modes.
from fastapi import HTTPException

@enforce_rules(operation_id="items-read_item", body_param="body")
async def _decorated_update(body: dict) -> str:
    return "REAL_METHOD_RAN"

os.environ["BSKEL_RULES_MODE"] = "observe"
observe_result = asyncio.run(_decorated_update(violating_body))
assert observe_result == "REAL_METHOD_RAN", "observe mode must always call the real method, even with real violations"

os.environ["BSKEL_RULES_MODE"] = "enforce"
secret_marker = "SECRET_MARKER_VALUE_12345"
try:
    asyncio.run(_decorated_update({"capacity": 999, "ownerName": secret_marker}))
    assert False, "enforce mode must reject a real violation with HTTPException"
except HTTPException as exc:
    assert exc.status_code == 400
    detail = str(exc.detail)
    assert "capacity-cap" in detail, f"message should name the real rule id: {detail!r}"
    assert secret_marker not in detail, f"an enforce-mode rejection must NEVER leak an observed payload value: {detail!r}"
    assert "999" not in detail, f"an enforce-mode rejection must NEVER leak an observed numeric value either: {detail!r}"

enforce_valid_result = asyncio.run(_decorated_update(valid_body))
assert enforce_valid_result == "REAL_METHOD_RAN", "a valid payload must never be rejected, even in enforce mode"

@enforce_rules(operation_id="no-such-operation-for-smoke-test", body_param="body")
async def _decorated_no_rules(body: dict) -> str:
    return "REAL_METHOD_RAN"

no_rules_result = asyncio.run(_decorated_no_rules({}))
assert no_rules_result == "REAL_METHOD_RAN", "an operation with no compiled rules must be a silent no-op, even in enforce mode"

del os.environ["BSKEL_RULES_MODE"]

print("python-import-smoke: all generated modules imported successfully")

# D-runtime-conformance-receipts (cryptographic receipt attestation): the real cross-language proof
# -- sign a receipt via the REAL generated receipt_sign.py (real cryptography-package Ed25519, not
# a mock), print the result on a marker line for the calling Node script to verify against
# lib/attest.mjs's own verifyPayload() (unmodified). Same rigor as the async-wrapper probe above.
import json
import os

sign_input = json.loads(os.environ["BSKEL_SIGN_SMOKE_INPUT"])
app.observe.receipt_sign.configure(sign_input["privateKeyPem"])
assert app.observe.receipt_sign.is_configured(), "receipt_sign did not accept a real PKCS#8 Ed25519 private key PEM"
signature = app.observe.receipt_sign.sign(sign_input["receipt"])
print(f"SIGN_SMOKE_SIGNATURE:{signature}")
`;

console.log('python-import-smoke: importing every generated module for real (not just ast.parse)...');
const { publicKeyPem, privateKeyPem } = generateKeypair();
const signSmokeReceipt = {
	feature_id: FEATURE_ID,
	feature_uid: '6bcbb17e-72fe-4049-92b5-712125c5c1ec',
	operation_id: 'items-read_item',
	contract_ref: 'deadbeef'.repeat(8),
	verb: 'GET',
	status: 200,
	recorded_at: '2026-09-10T00:00:00.000Z',
	violations: [{ pointer: '/body/name', keyword: 'pattern', message: 'héllo wörld / slash "quote" 日本語' }],
};
let driverOutput;
try {
	driverOutput = sh(venvPython, ['-c', DRIVER_SOURCE], backendDir, {
		quiet: true,
		env: { ...process.env, PYTHONPATH: backendDir, BSKEL_SIGN_SMOKE_INPUT: JSON.stringify({ privateKeyPem, receipt: signSmokeReceipt }) },
	});
} catch (err) {
	fail(`real import of generated modules failed:\n${err.stderr || err.stdout || err.message}`);
}

const signatureLine = driverOutput.split('\n').find((line) => line.startsWith('SIGN_SMOKE_SIGNATURE:'));
if (!signatureLine) {
	fail(`the driver did not print a SIGN_SMOKE_SIGNATURE line -- got:\n${driverOutput}`);
}
const pythonSignature = signatureLine.slice('SIGN_SMOKE_SIGNATURE:'.length);
if (!verifyPayload(signSmokeReceipt, pythonSignature, publicKeyPem)) {
	fail('a signature produced by the real generated receipt_sign.py did not verify against lib/attest.mjs\'s own verifyPayload() -- cross-language canonicalization has diverged.');
}
console.log('python-import-smoke: PASS -- a real Python-signed receipt verified correctly in Node.');

console.log('python-import-smoke: PASS -- generated Python imported cleanly against real fastapi + sqlmodel.');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
