// D-handles-providers (G4): plan-unit tests (direct plan() calls against hand-built scanReport
// fixtures, mirroring test/handles-plan.test.mjs's approach for java-spring) plus a full CLI e2e
// pass for the python-fastapi handles provider. See DECISIONS.md.
// P3b (D-python-import-check): the "every generated .py file is syntactically valid Python
// (ast.parse)" e2e test that used to live here was replaced, not duplicated -- see
// scripts/python-import-smoke.mjs (npm run test:python-import), which imports every generated
// module for real against a pip-installed fastapi+sqlmodel, catching real API mismatches
// ast.parse structurally cannot. Same precedent as java-compile-smoke.mjs: the fast default
// `npm test` path doesn't duplicate what a dedicated, separately-invoked script already proves
// more strongly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plan as planPythonFastApi } from '../handles/providers/python-fastapi/plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd, input) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', input });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// ---- plan-unit fixture: one package root, 3 controllers, 3 entities exercising each of the
// gating conditions independently (Item: everything present; Widget: no idField; Gadget: no
// Public model). ----
function buildPlanFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-plan-'));
	const appDir = path.join(root, 'backend', 'app');
	fs.mkdirSync(path.join(appDir, 'api'), { recursive: true });
	fs.writeFileSync(path.join(appDir, '__init__.py'), '');
	fs.writeFileSync(path.join(appDir, 'api', '__init__.py'), '');
	fs.writeFileSync(path.join(appDir, 'api', 'deps.py'), `
from typing import Annotated
from fastapi import Depends
from sqlmodel import Session

def get_db(): pass

SessionDep = Annotated[Session, Depends(get_db)]
`);
	const itemsPath = path.join(appDir, 'api', 'items.py');
	fs.writeFileSync(itemsPath, `
from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])

@router.get("/", response_model=ItemsPublic)
def read_items(session: SessionDep, skip: int = 0):
    pass

@router.get("/{id}", response_model=ItemPublic)
def read_item(session: SessionDep, id: str):
    pass
`);
	const widgetsPath = path.join(appDir, 'api', 'widgets.py');
	fs.writeFileSync(widgetsPath, `
from fastapi import APIRouter

router = APIRouter(prefix="/widgets", tags=["widgets"])

@router.get("/{id}", response_model=WidgetPublic)
def read_widget(session: SessionDep, id: str):
    pass
`);
	const gadgetsPath = path.join(appDir, 'api', 'gadgets.py');
	fs.writeFileSync(gadgetsPath, `
from fastapi import APIRouter

router = APIRouter(prefix="/gadgets", tags=["gadgets"])

@router.get("/{id}")
def read_gadget(session: SessionDep, id: str):
    pass
`);
	const modelsPath = path.join(appDir, 'models.py');
	fs.writeFileSync(modelsPath, `
from sqlmodel import Field, SQLModel
import uuid

class Item(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)

class ItemPublic(SQLModel):
    id: uuid.UUID

class ItemsPublic(SQLModel):
    data: list

class Widget(SQLModel, table=True):
    name: str = Field(primary_key=False)

class WidgetPublic(SQLModel):
    name: str

class Gadget(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
`);

	const scanReport = {
		related_modules: [{
			module: 'items',
			controllers: [
				{ className: 'ItemsRouter', basePath: '/items', endpoints: [
					{ verb: 'GET', path: '/items', operationId: null, method: 'read_items', line: 8 },
					{ verb: 'GET', path: '/items/{id}', operationId: null, method: 'read_item', line: 12 },
				], file: itemsPath },
				{ className: 'WidgetsRouter', basePath: '/widgets', endpoints: [
					{ verb: 'GET', path: '/widgets/{id}', operationId: null, method: 'read_widget', line: 6 },
				], file: widgetsPath },
				{ className: 'GadgetsRouter', basePath: '/gadgets', endpoints: [
					{ verb: 'GET', path: '/gadgets/{id}', operationId: null, method: 'read_gadget', line: 6 },
				], file: gadgetsPath },
			],
			entities: [
				{ className: 'Item', table: 'item', idField: 'id', file: modelsPath },
				{ className: 'Widget', table: 'widget', idField: null, file: modelsPath },
				{ className: 'Gadget', table: 'gadget', idField: 'id', file: modelsPath },
			],
		}],
	};
	return { root, scanReport };
}

test('plan: operationId=null (always, per D-fastapi-adapter) still finds the fetch route via ep.method, not ep.operationId', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: ['Item'] });
	const item = result.resources.find((r) => r.type === 'Item');
	assert.ok(item.fetchRoute, 'fetchRoute should be found even though operationId is null');
	assert.equal(item.fetchRoute.method, 'read_item');
});

test('plan: the list route (GET /items, no trailing path param) is never mistaken for the single-resource fetch', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: ['Item'] });
	const item = result.resources.find((r) => r.type === 'Item');
	assert.equal(item.fetchRoute.path, '/items/{id}');
});

test('plan: no <Entity>Public class -> resolver NOT generated, with a note naming the leak risk (Gadget has a fetch route but no GadgetPublic)', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: ['Gadget'] });
	const gadget = result.resources.find((r) => r.type === 'Gadget');
	assert.equal(gadget.willGenerateResolver, false);
	assert.equal(gadget.publicModel, null);
	assert.ok(result.notes.some((n) => n.includes('Gadget') && n.includes('GadgetPublic') && n.includes('leak')));
});

test('plan: no idField -> resolver NOT generated (Widget has a fetch route and WidgetPublic, but no primary key)', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: ['Widget'] });
	const widget = result.resources.find((r) => r.type === 'Widget');
	assert.equal(widget.willGenerateResolver, false);
	assert.ok(result.notes.some((n) => n.includes('Widget') && n.includes('primary-key')));
});

test('plan: --resource filter narrows to the named entity only', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: ['Item'] });
	assert.deepEqual(result.resources.map((r) => r.type), ['Item']);
});

test('plan: no __init__.py anywhere above the scanned files (PEP 420 implicit namespace package) -> throws naming that limitation, not a silent guess', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-plan-nopkg-'));
	const modelsPath = path.join(root, 'app', 'models.py');
	fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
	fs.writeFileSync(modelsPath, 'from sqlmodel import SQLModel\nclass Item(SQLModel, table=True):\n    pass\n');
	const scanReport = { related_modules: [{ module: 'items', controllers: [], entities: [{ className: 'Item', table: 'item', idField: null, file: modelsPath }] }] };
	assert.throws(() => planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: null }), /could not detect a Python package root/);
});

// D-typescript-express-provider slice-4 correction: this project's own DECISIONS.md/CATALOG.md
// used to describe python-fastapi as refusing "src/-layout" broadly -- imprecise. `packageRootFor`
// walks up while `__init__.py` exists regardless of what any directory is named, so a STANDARD
// PyPA src-layout (`src/<package>/__init__.py`, a REAL `__init__.py`, just nested under a `src/`
// directory) already plans correctly today. Only the negative test above (zero `__init__.py`
// anywhere -- a genuine PEP 420 implicit namespace package) was ever covered; this is the missing
// positive case, proving the realistic layout works, not just that the unrealistic one is refused.
test('plan: a standard src-layout (src/<package>/__init__.py, real __init__.py files, no bare `src` package marker) already plans correctly -- this was never a real gap, just an untested one', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-plan-srclayout-'));
	const pkgDir = path.join(root, 'src', 'app');
	const apiDir = path.join(pkgDir, 'api');
	fs.mkdirSync(apiDir, { recursive: true });
	// `src/` itself deliberately has NO __init__.py (it isn't a package, matching the real PyPA
	// convention) -- only `src/app/` and `src/app/api/` do.
	fs.writeFileSync(path.join(pkgDir, '__init__.py'), '');
	fs.writeFileSync(path.join(apiDir, '__init__.py'), '');
	fs.writeFileSync(path.join(apiDir, 'deps.py'), `
from typing import Annotated
from fastapi import Depends
from sqlmodel import Session

def get_db(): pass

SessionDep = Annotated[Session, Depends(get_db)]
`);
	const itemsPath = path.join(apiDir, 'items.py');
	fs.writeFileSync(itemsPath, `
from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])

@router.get("/{id}", response_model=ItemPublic)
def read_item(session: SessionDep, id: str):
    pass
`);
	const modelsPath = path.join(pkgDir, 'models.py');
	fs.writeFileSync(modelsPath, `
from sqlmodel import Field, SQLModel
import uuid

class Item(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)

class ItemPublic(SQLModel):
    id: uuid.UUID
`);
	const scanReport = {
		related_modules: [{
			module: 'items',
			controllers: [{ className: 'ItemsRouter', basePath: '/items', endpoints: [
				{ verb: 'GET', path: '/items/{id}', operationId: null, method: 'read_item', line: 6 },
			], file: itemsPath }],
			entities: [{ className: 'Item', table: 'item', idField: 'id', file: modelsPath }],
		}],
	};
	const result = planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: ['Item'] });
	assert.equal(result.importRoot, path.join(root, 'src'), 'expected importRoot to resolve to the src/ directory itself, not app/ or repoRoot');
	assert.equal(result.topPackage, 'app');
	const item = result.resources.find((r) => r.type === 'Item');
	assert.equal(item.willGenerateResolver, true, `expected Item to generate under a real src-layout -- notes: ${JSON.stringify(result.notes)}`);
});

test('plan: two genuinely different package roots among this module\'s own files -> throws naming both candidates', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-plan-ambiguous-'));
	const aDir = path.join(root, 'pkg_a');
	const bDir = path.join(root, 'pkg_b');
	fs.mkdirSync(aDir, { recursive: true });
	fs.mkdirSync(bDir, { recursive: true });
	fs.writeFileSync(path.join(aDir, '__init__.py'), '');
	fs.writeFileSync(path.join(bDir, '__init__.py'), '');
	const modelsPath = path.join(aDir, 'models.py');
	const routesPath = path.join(bDir, 'routes.py');
	fs.writeFileSync(modelsPath, '');
	fs.writeFileSync(routesPath, '');
	const scanReport = {
		related_modules: [{
			module: 'items',
			controllers: [{ className: 'ItemsRouter', basePath: '/items', endpoints: [], file: routesPath }],
			entities: [{ className: 'Item', table: 'item', idField: 'id', file: modelsPath }],
		}],
	};
	assert.throws(() => planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: null }), /ambiguous Python package root/);
});

// ---- e2e (CLI) fixture: reuses the same shape, real git repo, full plan+emit+verify pass. ----
function buildE2eFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-e2e-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

	const appDir = path.join(root, 'backend', 'app');
	fs.mkdirSync(path.join(appDir, 'api'), { recursive: true });
	fs.writeFileSync(path.join(appDir, '__init__.py'), '');
	fs.writeFileSync(path.join(appDir, 'api', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'backend', 'pyproject.toml'), '[project]\nname = "fixture"\ndependencies = ["fastapi>=0.100.0", "sqlmodel>=0.0.24"]\n');
	fs.writeFileSync(path.join(appDir, 'api', 'deps.py'), `
from typing import Annotated
from fastapi import Depends
from sqlmodel import Session

def get_db(): pass

SessionDep = Annotated[Session, Depends(get_db)]
`);
	fs.writeFileSync(path.join(appDir, 'api', 'items.py'), `
from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])

@router.get("/{id}", response_model=ItemPublic)
def read_item(session: SessionDep, id: str):
    pass
`);
	fs.writeFileSync(path.join(appDir, 'models.py'), `
from sqlmodel import Field, SQLModel
import uuid

class Item(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    hashed_password: str = ""

class ItemPublic(SQLModel):
    id: uuid.UUID
`);
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-e2e-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runToHandlesEmit(root, extraArgs = []) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'item-management'], root);
	run(['scan', '--feature', '001-item-management', '--terms', 'item', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-item-management', '--mode', 'extend', '--note', 'test'], root);
	// The fixture's operationId is always null (D-fastapi-adapter) -- contract emit is out of
	// scope here, force past it since this suite's focus is handles codegen, not contracts.
	run(['gate', 'force', 'contract', '--feature', '001-item-management', '--reason', 'handles-only test, contract covered elsewhere'], root);
	return run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--json', ...extraArgs], root);
}

test('e2e: handles emit writes exactly the expected files, no .java, including a real migration.sql', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root);
	assert.equal(emit.code, 0, emit.stderr);
	const result = JSON.parse(emit.stdout);
	const written = result.written.sort();
	// G4 follow-up (D-handles-providers): tables.py/handle_service.py/record_snapshot.py (new
	// infra) + migration.sql (new spec output) join the pre-existing file set.
	// D-resolver-policy-split: item_policy.py (CONTRACT_REF/FEATURE_UID's own always-safe-regen
	// companion module) joins item.py.
	assert.deepEqual(written, [
		'backend/app/handles/__init__.py',
		'backend/app/handles/codec.py',
		'backend/app/handles/handle_service.py',
		'backend/app/handles/record_snapshot.py',
		'backend/app/handles/registry.py',
		'backend/app/handles/resolvers/__init__.py',
		'backend/app/handles/resolvers/item.py',
		'backend/app/handles/resolvers/item_policy.py',
		'backend/app/handles/router.py',
		'backend/app/handles/tables.py',
		'specs/001-item-management/handles/migration.sql',
	].sort());
	const migrationContent = fs.readFileSync(path.join(root, 'specs', '001-item-management', 'handles', 'migration.sql'), 'utf8');
	assert.match(migrationContent, /create table if not exists sbf_handle\b/);
	assert.match(migrationContent, /create table if not exists sbf_handle_snapshot\b/);
	assert.ok(result.postEmitNotes.some((n) => n.includes('include_router')));
	assert.ok(result.postEmitNotes.some((n) => n.includes('migration.sql')));
	assert.ok(result.postEmitNotes.some((n) => n.includes('record_snapshot')));
});

// O3 follow-up (D-handle-registry-enforcement, "Continued"): the bootstrapping-trap warning --
// the fixture's real items.py (above) carries no @record_snapshot, so turning enforcement on
// should warn specifically about Item, naming the route file.
test('e2e: --enforce-registry on warns that Item has no @record_snapshot anywhere in its own route file', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root, ['--enforce-registry', 'on']);
	assert.equal(emit.code, 0, emit.stderr);
	const result = JSON.parse(emit.stdout);
	assert.ok(result.postEmitNotes.some((n) => n.startsWith('Item:') && n.includes('no @record_snapshot(...)') && n.includes('items.py')));
});

test('e2e: --enforce-registry on does not warn once @record_snapshot is already present in Item\'s own route file', () => {
	const root = buildE2eFixtureRepo();
	const itemsPath = path.join(root, 'backend', 'app', 'api', 'items.py');
	fs.writeFileSync(itemsPath, `
from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])

@record_snapshot(resource_type="Item", operation_id="read_item", resource_uid_param="id", session_param="session")
@router.get("/{id}", response_model=ItemPublic)
def read_item(session: SessionDep, id: str):
    pass
`);
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'apply record_snapshot to items.py'], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });

	const emit = runToHandlesEmit(root, ['--enforce-registry', 'on']);
	assert.equal(emit.code, 0, emit.stderr);
	const result = JSON.parse(emit.stdout);
	assert.ok(!result.postEmitNotes.some((n) => n.includes('no @record_snapshot')));
});

test('e2e: without --enforce-registry (the default, off) no per-resource registration warning is emitted', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root);
	assert.equal(emit.code, 0, emit.stderr);
	const result = JSON.parse(emit.stdout);
	assert.ok(!result.postEmitNotes.some((n) => n.includes('no @record_snapshot')));
});

test('e2e: check_access always denies (403), patch_field always 501, hashed_password never referenced by the resolver', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const resolverSrc = fs.readFileSync(path.join(root, 'backend', 'app', 'handles', 'resolvers', 'item.py'), 'utf8');
	assert.match(resolverSrc, /status_code=403/);
	assert.match(resolverSrc, /status_code=501/);
	assert.ok(!resolverSrc.includes('hashed_password'), 'the resolver must only ever touch the Public projection, never the raw table model\'s fields directly');
	assert.match(resolverSrc, /ItemPublic\.model_validate\(obj\)/);
});

test('e2e: the router checks PATCH kind explicitly (kind=="f" AND pointer present), not just pointer-presence', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const routerSrc = fs.readFileSync(path.join(root, 'backend', 'app', 'handles', 'router.py'), 'utf8');
	assert.match(routerSrc, /decoded\.kind != "f" or decoded\.pointer is None/);
});

test('e2e: bskel verify tracks a real migration.sql artifact for python-fastapi (G4 follow-up -- previously no artifact check existed at all)', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root);
	assert.equal(emit.code, 0, emit.stderr);
	const verify = run(['verify', '--feature', '001-item-management', '--json'], root);
	const report = JSON.parse(verify.stdout);
	const migrationArtifact = report.artifacts.find((a) => a.artifact.includes('migration'));
	assert.ok(migrationArtifact, 'expected a migration artifact check now that python-fastapi declares outputs.spec');
	assert.equal(migrationArtifact.exists, true);
});

test('e2e: re-emit is idempotent -- nothing rewritten except migration.sql (regenerated fresh every run, unconditionally, same as java-spring), resolver stays byte-identical', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const resolverPath = path.join(root, 'backend', 'app', 'handles', 'resolvers', 'item.py');
	const before = fs.readFileSync(resolverPath, 'utf8');
	const second = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--json'], root);
	assert.equal(second.code, 0, second.stderr);
	const result = JSON.parse(second.stdout);
	assert.deepEqual(result.written, ['specs/001-item-management/handles/migration.sql']);
	assert.equal(fs.readFileSync(resolverPath, 'utf8'), before);
});

test('e2e: hand-editing a generated resolver then re-running exits 15 and leaves the file byte-for-byte untouched', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const resolverPath = path.join(root, 'backend', 'app', 'handles', 'resolvers', 'item.py');
	const edited = `${fs.readFileSync(resolverPath, 'utf8')}\n# hand-finished by a human\n`;
	fs.writeFileSync(resolverPath, edited);
	const second = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items'], root);
	assert.equal(second.code, 15);
	assert.equal(fs.readFileSync(resolverPath, 'utf8'), edited);
});

// D-resolver-policy-split: permanent regression for the exact live reproduction that found this
// gap in python-fastapi (documented as CONFIRMED, not theorized, in DECISIONS.md's own entry).
// Before the split, CONTRACT_REF lived in the SAME file as check_access()/patch_field(), so a
// hand-finished check_access() (a legitimate, expected divergence -- see the test above) blocked a
// narrow, unrelated, contract-derived value from ever applying, indefinitely -- CONTRACT_REF feeds
// router.py's schema_drift check. `--openapi-file` is required here (not the simpler
// buildE2eFixtureRepo()/`gate force contract` shortcut used above): python-fastapi's scanned
// operationId is always null (D-fastapi-adapter), so a real, evolving `contract emit` -- the only
// way to change CONTRACT_REF's own hash for real -- needs a real OpenAPI source document. Fixture
// shape copied from test/handles-check-cli.test.mjs's own buildPythonFixtureRepo().
function buildOpenApiFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-policy-split-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

	fs.mkdirSync(path.join(root, 'backend', 'app', 'api', 'routes'), { recursive: true });
	fs.mkdirSync(path.join(root, 'backend', 'app', 'core'), { recursive: true });
	fs.writeFileSync(path.join(root, 'backend', 'app', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', 'routes', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'backend', 'pyproject.toml'), '[project]\nname = "fixture-backend"\ndependencies = ["fastapi[standard]>=0.141.1,<1.0.0", "sqlmodel>=0.0.24"]\n');
	fs.writeFileSync(path.join(root, 'backend', 'app', 'core', 'config.py'), 'class Settings:\n    API_V1_STR: str = "/api/v1"\n\nsettings = Settings()\n');
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', 'deps.py'), `
from typing import Annotated
from fastapi import Depends
from sqlmodel import Session


def get_db():
    pass


SessionDep = Annotated[Session, Depends(get_db)]
`);
	fs.writeFileSync(path.join(root, 'backend', 'app', 'main.py'), `
from fastapi import FastAPI
from app.api.main import api_router
from app.core.config import settings

app = FastAPI()
app.include_router(api_router, prefix=settings.API_V1_STR)
`);
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', 'routes', 'items.py'), `
from fastapi import APIRouter
from app.models import Item, ItemPublic

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/{id}", response_model=ItemPublic)
async def read_item(session: SessionDep, id: str):
    pass
`);
	fs.writeFileSync(path.join(root, 'backend', 'app', 'models.py'), `
from sqlmodel import Field, SQLModel
import uuid


class ItemBase(SQLModel):
    title: str


class Item(ItemBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)


class ItemPublic(ItemBase):
    id: uuid.UUID
`);
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-policy-split-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('a hand-finished check_access() blocks item.py but must NOT block an unrelated contract change from reaching item_policy.py', () => {
	const root = buildOpenApiFixtureRepo();
	const openApiPath = path.join(root, 'openapi.json');

	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'item-management'], root);
	run(['scan', '--feature', '001-item-management', '--terms', 'item', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-item-management', '--mode', 'extend', '--note', 'test'], root);
	// D-cli-contract convention (matching test/handles-check-cli.test.mjs's own python fixture):
	// openapi.json is written AFTER preflight, not before -- an untracked file at repo root would
	// otherwise make preflight's own dirty-tree check fail; contract emit only re-checks scan/
	// disposition, not preflight's own gate.
	fs.writeFileSync(openApiPath, JSON.stringify({
		openapi: '3.1.0',
		paths: { '/api/v1/items/{id}': { get: { operationId: 'items-read_item', responses: {} } } },
	}));
	assert.equal(run(['contract', 'emit', '--feature', '001-item-management', '--module', 'items', '--openapi-file', openApiPath, '--path-prefix', '/api/v1'], root).code, 0);
	assert.equal(run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items'], root).code, 0);

	const resolverPath = path.join(root, 'backend', 'app', 'handles', 'resolvers', 'item.py');
	const policyPath = path.join(root, 'backend', 'app', 'handles', 'resolvers', 'item_policy.py');
	assert.ok(fs.existsSync(policyPath), 'expected the new always-safe-regen companion module to exist');
	const contractRefBefore = fs.readFileSync(policyPath, 'utf8').match(/CONTRACT_REF = "([^"]+)"/)[1];

	// Simulate a human finishing the generated check_access() stub -- same style as the hand-edit
	// test above, a legitimate divergence that must keep blocking item.py's own regeneration forever.
	const handEdited = fs.readFileSync(resolverPath, 'utf8').replace(
		'raise HTTPException(status_code=403, detail="access check not yet implemented for Item")',
		'if getattr(obj, "owner_id", None) is not None:\n            pass  # hand-completed: real ownership check reviewed and approved\n        raise HTTPException(status_code=403, detail="access check not yet implemented for Item")',
	);
	fs.writeFileSync(resolverPath, handEdited);

	// A real, narrow, contract-affecting change -- a new query parameter -- via a re-emitted
	// --openapi-file, the only way to change CONTRACT_REF's own hash for real here.
	fs.writeFileSync(openApiPath, JSON.stringify({
		openapi: '3.1.0',
		paths: { '/api/v1/items/{id}': { get: { operationId: 'items-read_item', parameters: [{ name: 'verbose', in: 'query', schema: { type: 'boolean' } }], responses: {} } } },
	}));
	assert.equal(run(['contract', 'emit', '--feature', '001-item-management', '--module', 'items', '--openapi-file', openApiPath, '--path-prefix', '/api/v1'], root).code, 0);

	const check = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--check', '--diff', '--json'], root);
	assert.equal(check.code, 15, 'the hand-finished check_access() must still block item.py');
	const checkBody = JSON.parse(check.stdout);
	assert.equal(checkBody.blocked, true);
	assert.equal(checkBody.conflicts.length, 1);
	assert.ok(checkBody.conflicts[0].path.endsWith('resolvers/item.py'));

	const resolverAction = checkBody.actions.find((a) => a.path.endsWith('resolvers/item.py'));
	assert.equal(resolverAction.action, 'conflict', 'item.py: hand-finished check_access() correctly still conflicts');

	const policyAction = checkBody.actions.find((a) => a.path.endsWith('resolvers/item_policy.py'));
	assert.equal(policyAction.action, 'update', 'item_policy.py: no hand-edit here, so the contract change is free to apply');
	assert.match(policyAction.diff, new RegExp(`-CONTRACT_REF = "${contractRefBefore}"`));
	assert.match(policyAction.diff, /\+CONTRACT_REF = "[0-9a-f]{64}"/);

	// The real, non---check emit: still blocked overall (exit 15, item.py's conflict is real and
	// must not be silently discarded) -- but resolver units are independent per file, so the
	// policy module's update is NOT held hostage by the sibling conflict. This on-disk assertion is
	// exactly the one that would have failed before D-resolver-policy-split: the contract change
	// would never have reached disk at all, silently, for as long as the hand-edit remained.
	const real = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--json'], root);
	assert.equal(real.code, 15);
	const realBody = JSON.parse(real.stdout);
	assert.equal(realBody.blocked, true);
	assert.equal(realBody.conflicts.length, 1);

	assert.equal(fs.readFileSync(resolverPath, 'utf8'), handEdited, 'item.py must remain byte-for-byte untouched, hand-edit intact');
	const contractRefAfter = fs.readFileSync(policyPath, 'utf8').match(/CONTRACT_REF = "([^"]+)"/)[1];
	assert.notEqual(contractRefAfter, contractRefBefore, 'item_policy.py must actually carry the new CONTRACT_REF on disk despite the overall run reporting blocked');
});
