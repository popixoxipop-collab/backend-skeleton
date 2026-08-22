#!/usr/bin/env node
// G4 follow-up (D-handles-providers): proof that python-fastapi's own handle read/snapshot
// lifecycle (register -> a decorated service function is called for real -> a real HTTP GET
// recover) actually works against a real, disposable Postgres -- the same real invariants
// scripts/java-integration-smoke.mjs proves for java-spring's own O4 work, adapted to this
// ecosystem: FastAPI's own TestClient drives real in-process ASGI request/response cycles (real
// routing, real Pydantic validation, real dependency injection, real PATCH) with no bound port
// at all -- meaningfully cheaper than Java's own `@SpringBootTest(webEnvironment=RANDOM_PORT)` +
// real HTTP client requirement (which existed only because TestRestTemplate can't do PATCH; no
// such forcing function exists here), while still exercising a real Postgres, never SQLite (this
// repo's own established precedent for anything DB-shaped, and SQLite could hide a real
// Postgres-only bug in the emitted jsonb/unique constraints this whole exercise exists to prove
// work).
//
// Requires `python3` on PATH and `BSKEL_TEST_DATABASE_URL` pointing at a real (throwaway)
// Postgres this script is free to create/drop tables in -- same DB_URL_ENV_NAME convention
// db-introspect-smoke.mjs/java-integration-smoke.mjs already established, never read from .env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'python-fastapi');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const FEATURE_ID = '001-item-management';
const DB_URL_ENV_NAME = 'BSKEL_TEST_DATABASE_URL';

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
	console.error(`python-integration-smoke: FAIL -- ${message}`);
	process.exit(1);
}

const connectionString = process.env[DB_URL_ENV_NAME];
if (!connectionString) {
	fail(`${DB_URL_ENV_NAME} is not set -- point it at a real (throwaway) Postgres this script may create/drop tables in`);
}
// Node's `pg` accepts the `postgres://` scheme (used above for setupClient/cleanupClient), but
// SQLAlchemy's dialect registry only recognizes `postgresql://` -- confirmed live (a real
// NoSuchModuleError, not assumed): the two ecosystems disagree on this alias, so the driver
// script below needs its own normalized copy of the connection string, not the raw env value.
const sqlalchemyUrl = connectionString.replace(/^postgres:\/\//, 'postgresql://');

console.log('python-integration-smoke: copying fixture to a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-integration-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.venv/\n');

sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: python-integration-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-integration-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

console.log('python-integration-smoke: preflight -> feature init -> scan -> disposition -> handles emit...');
let r = bskel(['preflight'], scratch);
if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);

r = bskel(['feature', 'init', '--slug', 'item-management'], scratch);
if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

r = bskel(['scan', '--feature', FEATURE_ID, '--terms', 'item'], scratch);
if (![0, 3].includes(r.code)) fail(`scan: exit ${r.code}: ${r.stderr || r.stdout}`);

r = bskel(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'extend', '--note', 'python-integration-smoke'], scratch);
if (r.code !== 0) fail(`scan disposition: ${r.stderr || r.stdout}`);

// D-fastapi-adapter: this scanner's operationId is always null, so contract emit is out of scope
// for this smoke script the same way python-import-smoke.mjs's own fixture forces past it.
r = bskel(['gate', 'force', 'contract', '--feature', FEATURE_ID, '--reason', 'handles-only smoke test, contract covered elsewhere'], scratch);
if (r.code !== 0) fail(`gate force contract: ${r.stderr || r.stdout}`);

r = bskel(['handles', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--json'], scratch);
if (r.code !== 0) fail(`handles emit: ${r.stderr || r.stdout}`);

const migrationPath = path.join(scratch, 'specs', FEATURE_ID, 'handles', 'migration.sql');
if (!fs.existsSync(migrationPath)) fail(`expected ${migrationPath} to exist after handles emit`);
const migrationSql = fs.readFileSync(migrationPath, 'utf8');

// The generated resolver's check_access() is a PERMANENT fail-closed stub by design (this
// provider can never auto-generate a working one -- see resolver.py.tmpl's own docstring) --
// every real HTTP call this script makes would otherwise 403 before ever reaching the lifecycle
// logic this script exists to prove. Patched here the same way java-integration-smoke.mjs's own
// fixture solves the identical problem for Java: test/fixtures/java-compile's TestSecurityConfig
// unconditionally stamps a ROLE_ADMIN authentication onto every request ("this test cares
// whether the HANDLE LIFECYCLE plumbing works, not whether a real login flow does") -- this is
// the Python-ecosystem equivalent of that same test-only override, not a weakening of the
// shipped template (a real consumer still gets the fail-closed stub; only this script's own
// scratch copy is patched, after a real `handles emit` already generated the real stub).
const resolverPath = path.join(scratch, 'backend', 'app', 'handles', 'resolvers', 'item.py');
const resolverSrc = fs.readFileSync(resolverPath, 'utf8');
const patchedResolverSrc = resolverSrc.replace(
	/    def check_access\(self, session, obj\) -> None:\n(?:.*\n)*?        raise HTTPException\(status_code=403, detail="access check not yet implemented for Item"\)\n/,
	'    def check_access(self, session, obj) -> None:\n        pass  # python-integration-smoke: test-only override, see this script\'s own comment\n',
);
if (patchedResolverSrc === resolverSrc) fail('could not patch the generated resolver\'s check_access() -- the stub\'s shape may have changed');
fs.writeFileSync(resolverPath, patchedResolverSrc);

console.log('python-integration-smoke: applying the REAL emitted migration.sql (not a hand-copied duplicate) + an items table...');
const setupClient = new Client({ connectionString });
await setupClient.connect();
await setupClient.query('drop table if exists sbf_handle_snapshot, sbf_handle, item cascade');
await setupClient.query(migrationSql);
// Matches Item's own real SQLModel mapping exactly (test/fixtures/python-fastapi/backend/app/
// models.py) -- this script's own explicit SQL is the only thing that ever creates this table.
await setupClient.query('create table item (id uuid primary key, title varchar(255), internal_note varchar(255), hashed_password varchar(255))');
await setupClient.end();

console.log('python-integration-smoke: creating a throwaway venv and installing fastapi + sqlmodel + psycopg2-binary...');
const backendDir = path.join(scratch, 'backend');
try {
	sh('python3', ['-m', 'venv', '.venv'], scratch, { quiet: true });
} catch (err) {
	fail(`could not create a venv -- is \`python3\` on PATH with the venv module available? (${err.message})`);
}
const venvPython = path.join(scratch, '.venv', 'bin', 'python');
try {
	sh(venvPython, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'fastapi', 'sqlmodel', 'psycopg2-binary', 'httpx'], scratch, { quiet: true });
} catch (err) {
	fail(`pip install failed: ${err.stderr || err.message}`);
}

// A small, test-only driver (not a generated artifact) -- real FastAPI app, real TestClient, real
// Postgres session (via a dependency_overrides swap of the fixture's own no-op get_db, the
// standard FastAPI testing pattern), exercising the SAME four real invariants
// java-integration-smoke.mjs's own @SpringBootTest suite proves: (1) full lifecycle, (2)
// schema_drift, (3) field-level fetch, (4) persistence-layer redaction.
const DRIVER_SOURCE = `
import sys, uuid
from sqlalchemy import create_engine
from sqlmodel import Session, select
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, ".")
import app.handles.codec as codec
import app.handles.tables as tables
from app.handles.router import router as handles_router
from app.handles.resolvers.item import ItemResolver
from app.services.item_service import update_item
from app.models import Item
from app.api.deps import get_db

engine = create_engine("${sqlalchemyUrl}")

fastapi_app = FastAPI()
fastapi_app.include_router(handles_router)

def _get_session():
    with Session(engine) as session:
        yield session

fastapi_app.dependency_overrides[get_db] = _get_session
client = TestClient(fastapi_app)

failures = []

def check(label, condition):
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}")
    if not condition:
        failures.append(label)

# Seed one real Item row directly.
item_id = uuid.uuid4()
with Session(engine) as session:
    session.add(Item(id=item_id, title="Original Title", internal_note="do not leak this"))
    session.commit()

# --- Scenario 1: full lifecycle -- call the decorated fixture function for real (this
# provider's patch_field() is a PERMANENT 501 stub by design, so there is no generated PATCH path
# that could ever trigger the decorator through a real HTTP call -- calling the decorated
# function directly is still a real call through the real decorator, real DB writes, matching
# what java-integration-smoke.mjs's own WidgetServiceImpl-through-real-HTTP-PATCH proves, just
# entered a different way for a structural reason named in DECISIONS.md).
with Session(engine) as session:
    result = update_item(session, item_id, {"title": "Updated Title", "internal_note": "do not leak this"})
    # Read while still attached to its Session -- accessing an ORM attribute after the session
    # that loaded it has closed raises DetachedInstanceError (confirmed live, not assumed).
    result_title = result.title
check("full lifecycle: update_item() returns the updated row", result_title == "Updated Title")

token = codec.encode_handle("r", "Item", str(item_id))
recover_resp = client.get(f"/handles/{token}/recover")
check("recover(): 200", recover_resp.status_code == 200)
body = recover_resp.json() if recover_resp.status_code == 200 else {}
check("recover(): payload.title reflects the real update", body.get("payload", {}).get("title") == "Updated Title")
check("recover(): schema_drift is false (no contract change happened)", body.get("schema_drift") is False)

# --- Scenario 2: schema_drift -- directly mutate the registry row's contract_ref (same
# direct-DB-row technique java-integration-smoke.mjs's own test uses, avoiding a real
# contract-edit-and-re-emit mid-script) and confirm recover() reports drift.
handle_uid = uuid.UUID(codec.derive_handle_uid("r", "Item", str(item_id), None))
with Session(engine) as session:
    registry = session.get(tables.HandleRegistry, handle_uid)
    registry.contract_ref = "a-different-contract-hash"
    session.add(registry)
    session.commit()
drift_resp = client.get(f"/handles/{token}/recover")
check("recover(): schema_drift is true after the registry's contract_ref diverges from the snapshot's", drift_resp.json().get("schema_drift") is True)

# --- Scenario 3: field-level fetch -- a real pointer resolves, a missing one 404s. The pointer
# is baked INTO the encoded token itself (kind="f"), not appended to the URL -- a fresh token per
# pointer, matching how decode_handle()/encode_handle() actually address a field.
title_token = codec.encode_handle("f", "Item", str(item_id), "/title")
fetch_resp = client.get(f"/handles/{title_token}")
check("field fetch: GET the /title field handle resolves to the real current value", fetch_resp.status_code == 200 and fetch_resp.json() == "Updated Title")
missing_token = codec.encode_handle("f", "Item", str(item_id), "/does_not_exist")
missing_resp = client.get(f"/handles/{missing_token}")
check("field fetch: a genuinely missing pointer 404s", missing_resp.status_code == 404)

# --- Scenario 4: persistence-layer redaction -- proven at the PERSISTENCE layer, not the HTTP
# response: query HandleSnapshot directly and confirm the redacted value is genuinely absent from
# the stored payload column, matching java-integration-smoke.mjs's own plan text exactly. The
# "request" envelope is update_item()'s own \`updates\` dict (the sole non-uid/session parameter,
# unwrapped per record_snapshot's own single-parameter convention) -- a real dict carrying
# internal_note, unlike a bare scalar parameter, which is exactly why the fixture function takes
# a dict rather than a bare \`title: str\`.
with Session(engine) as session:
    snapshot = session.exec(
        select(tables.HandleSnapshot)
        .where(tables.HandleSnapshot.handle_uid == handle_uid, tables.HandleSnapshot.envelope_dir == "request")
        .order_by(tables.HandleSnapshot.recorded_at.desc())
    ).first()
    snapshot_payload = snapshot.payload if snapshot is not None else None
check("redaction: a request snapshot was actually recorded", snapshot is not None)
if snapshot_payload is not None:
    check("redaction: /internal_note is redacted in the STORED payload, not just the HTTP response", snapshot_payload.get("internal_note") == "***REDACTED***")

if failures:
    print(f"python-integration-smoke: {len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("python-integration-smoke: all real Postgres + TestClient checks passed")
`;

console.log('python-integration-smoke: running the real handle lifecycle against FastAPI TestClient + real Postgres...');
try {
	sh(venvPython, ['-c', DRIVER_SOURCE], backendDir, { env: { ...process.env, PYTHONPATH: backendDir } });
} catch (err) {
	fail(`real integration run failed (exit ${err.status}) -- see output above`);
}

console.log('python-integration-smoke: PASS -- the full handle lifecycle ran for real against a real Postgres.');

console.log('python-integration-smoke: cleaning up...');
const cleanupClient = new Client({ connectionString });
await cleanupClient.connect();
await cleanupClient.query('drop table if exists sbf_handle_snapshot, sbf_handle, item cascade');
await cleanupClient.end();
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
