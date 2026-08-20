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

test('plan: no __init__.py anywhere above the scanned files -> throws naming the src-layout limitation, not a silent guess', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-handles-plan-nopkg-'));
	const modelsPath = path.join(root, 'app', 'models.py');
	fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
	fs.writeFileSync(modelsPath, 'from sqlmodel import SQLModel\nclass Item(SQLModel, table=True):\n    pass\n');
	const scanReport = { related_modules: [{ module: 'items', controllers: [], entities: [{ className: 'Item', table: 'item', idField: null, file: modelsPath }] }] };
	assert.throws(() => planPythonFastApi({ repoRoot: root, scanReport, module: 'items', resourceFilter: null }), /could not detect a Python package root/);
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

function runToHandlesEmit(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'item-management'], root);
	run(['scan', '--feature', '001-item-management', '--terms', 'item', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-item-management', '--mode', 'extend', '--note', 'test'], root);
	// The fixture's operationId is always null (D-fastapi-adapter) -- contract emit is out of
	// scope here, force past it since this suite's focus is handles codegen, not contracts.
	run(['gate', 'force', 'contract', '--feature', '001-item-management', '--reason', 'handles-only test, contract covered elsewhere'], root);
	return run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--json'], root);
}

test('e2e: handles emit writes exactly the expected files, no .java, no migration.sql', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root);
	assert.equal(emit.code, 0, emit.stderr);
	const result = JSON.parse(emit.stdout);
	const written = result.written.sort();
	assert.deepEqual(written, [
		'backend/app/handles/__init__.py',
		'backend/app/handles/codec.py',
		'backend/app/handles/registry.py',
		'backend/app/handles/resolvers/__init__.py',
		'backend/app/handles/resolvers/item.py',
		'backend/app/handles/router.py',
	].sort());
	assert.ok(!fs.existsSync(path.join(root, 'specs', '001-item-management', 'handles', 'migration.sql')));
	assert.ok(result.postEmitNotes.some((n) => n.includes('include_router')));
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

test('e2e: bskel verify passes with no migration.sql at all (python-fastapi has none)', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root);
	assert.equal(emit.code, 0, emit.stderr);
	const verify = run(['verify', '--feature', '001-item-management', '--json'], root);
	const report = JSON.parse(verify.stdout);
	const migrationArtifact = report.artifacts.find((a) => a.artifact.includes('migration'));
	assert.equal(migrationArtifact, undefined, 'no migration artifact check should even be created for a provider with zero spec outputs');
});

test('e2e: re-emit is idempotent -- nothing rewritten, resolver stays byte-identical', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const resolverPath = path.join(root, 'backend', 'app', 'handles', 'resolvers', 'item.py');
	const before = fs.readFileSync(resolverPath, 'utf8');
	const second = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--json'], root);
	assert.equal(second.code, 0, second.stderr);
	const result = JSON.parse(second.stdout);
	assert.deepEqual(result.written, []);
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
