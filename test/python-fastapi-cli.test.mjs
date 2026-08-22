// G2: end-to-end CLI tests for the python-fastapi adapter -- the second first-class adapter,
// alongside java-spring (generic-grep stays a shallow fallback, see D-generic-grep-reconnaissance).
// Fixture/`run()` conventions copied from test/generic-grep-cli.test.mjs, which this file does not
// modify. Fixture shape deliberately mirrors the real oracle's tricky cases (nested under backend/,
// a router with no prefix, a multi-line decorator with a nested Depends() call, a two-step
// include_router(prefix=settings.API_V1_STR) resolution) rather than a toy. See DECISIONS.md
// D-fastapi-adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-fastapi-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

	fs.mkdirSync(path.join(root, 'backend', 'app', 'api', 'routes'), { recursive: true });
	fs.mkdirSync(path.join(root, 'backend', 'app', 'core'), { recursive: true });

	// G4: real package markers -- backend/app/ is the detected import root's top package
	// (backend/ itself has none, so importRoot="backend", topPackage="app"), matching the real
	// oracle's own layout. Needed for the python-fastapi handles provider's package-root detection.
	fs.writeFileSync(path.join(root, 'backend', 'app', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', 'routes', '__init__.py'), '');

	fs.writeFileSync(path.join(root, 'backend', 'pyproject.toml'), `
[project]
name = "fixture-backend"
dependencies = [
    "fastapi[standard]>=0.141.1,<1.0.0",
    "sqlmodel>=0.0.24",
]
`);

	fs.writeFileSync(path.join(root, 'backend', 'app', 'core', 'config.py'), `
class Settings:
    API_V1_STR: str = "/api/v1"

settings = Settings()
`);

	// G4: the actual SessionDep alias declaration the python-fastapi handles provider looks for --
	// the route files below only USE `SessionDep` as a parameter annotation, they never declare it,
	// exactly like the real oracle (deps.py is where it actually lives).
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

	// items.py: prefixed router, one multi-line decorator with a NESTED Depends() call (the real
	// complication that breaks a non-greedy "match up to the first close paren" regex).
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', 'routes', 'items.py'), `
from fastapi import APIRouter
from app.models import Item, ItemCreate, ItemPublic, ItemsPublic

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/", response_model=ItemsPublic)
def read_items(session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100):
    pass


@router.get("/{id}", response_model=ItemPublic)
async def read_item(session: SessionDep, current_user: CurrentUser, id: str):
    pass


@router.post("/", response_model=ItemPublic)
def create_item(*, session: SessionDep, current_user: CurrentUser, item_in: ItemCreate):
    pass


@router.get(
    "/summary",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=ItemPublic,
)
def item_summary(session: SessionDep):
    pass
`);

	// login.py: deliberately NO prefix at all -- the case that kills a prefix-derived module name.
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', 'routes', 'login.py'), `
from fastapi import APIRouter

router = APIRouter(tags=["login"])


@router.post("/login/access-token")
def login_access_token():
    pass
`);

	fs.writeFileSync(path.join(root, 'backend', 'app', 'models.py'), `
from sqlmodel import Field, SQLModel
import uuid


class ItemBase(SQLModel):
    title: str


class ItemCreate(ItemBase):
    pass


class Item(ItemBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID


class ItemPublic(ItemBase):
    id: uuid.UUID


class ItemsPublic(SQLModel):
    data: list
    count: int


class OrphanConfig(SQLModel, table=True):
    key: str = Field(primary_key=True)
`);

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-fastapi-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

// A pre-G2 baseline capture, using generic-grep directly (not the CLI) -- confirms in code, not
// just in a commit message, what the false-negative this item fixes actually looked like: real
// routes found, but collapsed into `_generic` with unresolved router-local paths that score 0.
async function scanWithGenericGrepOnly(repoRoot, terms) {
	const { runScan } = await import('../scanners/index.mjs');
	const { adapter: genericGrep } = await import('../scanners/adapters/generic-grep.mjs');
	return runScan({ repoRoot, terms, adapters: [genericGrep] });
}

test('adapter selection: python-fastapi wins over generic-grep via specificity alone, no code change needed', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'item', '--json'], root);
	assert.equal(scan.code, 0);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.adapter, 'python-fastapi');
	assert.equal(report.confidence, 'high');
});

test('headline regression: the same fixture that generic-grep reports as greenfield (false negative) is a real collision under python-fastapi', async () => {
	const root = buildFixtureRepo();
	const baseline = await scanWithGenericGrepOnly(root, ['item']);
	assert.equal(baseline.verdict, 'greenfield', 'documents the pre-G2 false negative this item fixes -- if this ever fails, generic-grep itself changed, not python-fastapi');

	const scan = run(['scan', '--terms', 'item', '--json'], root);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.verdict, 'collision');
	assert.ok(report.related_modules.some((m) => m.module === 'items'));
});

test('extraction fidelity: verb/path/method/line are correct, operationId is always null', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'item', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const itemsModule = report.related_modules.find((m) => m.module === 'items');
	assert.ok(itemsModule, 'expected an "items" module');
	const controller = itemsModule.controllers[0];
	assert.equal(controller.basePath, '/items');

	const byMethod = Object.fromEntries(controller.endpoints.map((e) => [e.method, e]));
	assert.equal(byMethod.read_items.verb, 'GET');
	assert.equal(byMethod.read_items.path, '/items');
	assert.equal(byMethod.read_item.verb, 'GET');
	assert.equal(byMethod.read_item.path, '/items/{id}');
	assert.equal(byMethod.create_item.verb, 'POST');
	assert.equal(byMethod.create_item.path, '/items');
	// The multi-line decorator with a nested Depends(...) call -- the case a non-greedy
	// "up to the first close paren" regex would truncate.
	assert.equal(byMethod.item_summary.verb, 'GET');
	assert.equal(byMethod.item_summary.path, '/items/summary');

	for (const e of controller.endpoints) assert.equal(e.operationId, null);

	const sourceText = fs.readFileSync(controller.file, 'utf8');
	const actualLine = sourceText.split('\n').findIndex((l) => l.includes('@router.get("/", response_model=ItemsPublic)')) + 1;
	assert.equal(byMethod.read_items.line, actualLine);
});

test('login.py has no APIRouter prefix, but its module is still "login" (filename stem, not prefix-derived)', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'login'], root);
	assert.equal(scan.code, 0);
	const scanJson = run(['scan', '--terms', 'login,item', '--json'], root);
	const report = JSON.parse(scanJson.stdout);
	const loginModule = report.related_modules.find((m) => m.module === 'login');
	assert.ok(loginModule, 'expected a "login" module even though its router declares no prefix');
	assert.equal(loginModule.controllers[0].basePath, '');
	assert.equal(loginModule.controllers[0].endpoints[0].path, '/login/access-token');
});

test('entities: table/idField extracted and cross-checked, Item attaches to the "items" module by name-match, unmatched OrphanConfig goes to _models', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'item,orphan,config', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const itemsModule = report.related_modules.find((m) => m.module === 'items');
	const itemEntity = itemsModule.entities.find((e) => e.className === 'Item');
	assert.ok(itemEntity, 'expected the Item entity attached to the items module');
	assert.equal(itemEntity.table, 'item');
	assert.equal(itemEntity.idField, 'id');

	const orphanModule = report.related_modules.find((m) => m.module === '_models');
	assert.ok(orphanModule, 'a table entity with no matching route module must land in _models, not be dropped');
	assert.ok(orphanModule.entities.some((e) => e.className === 'OrphanConfig' && e.table === 'orphanconfig' && e.idField === 'key'));
});

test('path-prefix signal (two-step include_router(prefix=settings.API_V1_STR) resolution) and apiSurfaceSource override', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'item', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const signal = report.path_prefix_signals.find((s) => s.kind === 'include_router-prefix');
	assert.ok(signal, 'expected an include_router-prefix signal');
	assert.equal(signal.prefix, '/api/v1');
	assert.equal(signal.via, 'settings.API_V1_STR');
	assert.ok(report.unknowns.some((u) => u.includes('/api/v1')), 'the resolved prefix should surface in the human-readable unknowns note');
	assert.match(report.api_surface_source, /operation ids at request-handling time/, 'python-fastapi must override the default api_surface_source string, not inherit it');
});

function runWorkflowThroughScan(root, featureId, terms) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', featureId.replace(/^\d+-/, '')], root);
	run(['scan', '--feature', featureId, '--terms', terms, '--json'], root);
	run(['scan', 'disposition', '--feature', featureId, '--mode', 'extend', '--note', 'test'], root);
}

// A minimal, real-shaped OpenAPI 3.1 document matching the fixture's `items` module exactly --
// paths under /api/v1 (the prefix extractIncludeRouterPrefixSignals resolves), real operationIds
// FastAPI's own convention would plausibly produce (tag-functionname, see the real oracle's
// custom_generate_unique_id).
function writeOpenApiDoc(dir) {
	const docPath = path.join(dir, 'openapi.json');
	fs.writeFileSync(docPath, JSON.stringify({
		openapi: '3.1.0',
		paths: {
			'/api/v1/items/': {
				get: { operationId: 'items-read_items', responses: {} },
				post: { operationId: 'items-create_item', responses: {} },
			},
			'/api/v1/items/{id}': { get: { operationId: 'items-read_item', responses: {} } },
			'/api/v1/items/summary': { get: { operationId: 'items-item_summary', responses: {} } },
		},
	}));
	return docPath;
}

test('contract emit without --openapi-file is blocked by the honest api.operations capability (exit 17), and the remediation now names --openapi-file', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughScan(root, '001-item-management', 'item');
	const result = run(['contract', 'emit', '--feature', '001-item-management', '--module', 'items'], root);
	assert.equal(result.code, 17);
	assert.match(result.stderr, /api\.operations/);
	assert.match(result.stderr, /python-fastapi/);
	assert.match(result.stderr, /--openapi-file/, 'the capability-satisfier remediation line must be present');
	assert.ok(!fs.existsSync(path.join(root, 'specs', '001-item-management', 'contracts', '001-item-management.schema.json')));
});

test('contract emit --openapi-file alone bypasses the capability gate but stays honestly blocked: prefix-inconclusive without --path-prefix', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughScan(root, '001-item-management', 'item');
	const docPath = writeOpenApiDoc(root);
	const result = run(['contract', 'emit', '--feature', '001-item-management', '--module', 'items', '--openapi-file', docPath], root);
	assert.notEqual(result.code, 17, 'the capability gate itself must be bypassed once --openapi-file is given');
	// A5: the contract is still written unconditionally, even blocked -- read it to confirm WHY.
	const contract = JSON.parse(fs.readFileSync(path.join(root, 'specs', '001-item-management', 'contracts', '001-item-management.schema.json'), 'utf8'));
	assert.equal(contract.completeness.status, 'blocked');
	assert.equal(Object.keys(contract.operations).length, 0);
	const unmatched = contract.warnings.filter((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT');
	assert.ok(unmatched.length > 0);
	assert.ok(unmatched.every((w) => w.detail.openapi_attempted === true && w.detail.openapi_reason === 'prefix-inconclusive'));
});

test('contract emit --openapi-file --path-prefix /api/v1 together adopt all 4 real operations, complete', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughScan(root, '001-item-management', 'item');
	const docPath = writeOpenApiDoc(root);
	const result = run(['contract', 'emit', '--feature', '001-item-management', '--module', 'items', '--openapi-file', docPath, '--path-prefix', '/api/v1', '--json'], root);
	assert.equal(result.code, 0);
	const contract = JSON.parse(result.stdout);
	assert.equal(contract.completeness.status, 'complete');
	assert.equal(Object.keys(contract.operations).length, 4);
	assert.ok(Object.hasOwn(contract.operations, 'items-read_items'));
	assert.ok(Object.hasOwn(contract.operations, 'items-read_item'));
	assert.ok(Object.hasOwn(contract.operations, 'items-create_item'));
	assert.ok(Object.hasOwn(contract.operations, 'items-item_summary'));
	assert.ok(contract.warnings.every((w) => w.severity === 'warn'), 'only WARN-severity CONTRACT_OPENAPI_DERIVED_OPERATION_ID/CONTRACT_BODY_UNKNOWN, nothing blocking');

	const gate = run(['gate', 'require', 'contract', '--feature', '001-item-management'], root);
	assert.equal(gate.code, 0);
});

// G4: this used to be the test proving `codegen.handles` blocked every python-fastapi feature at
// exit 17 -- that premise is exactly what G4 exists to invert. See D-handles-providers in
// DECISIONS.md and test/python-fastapi-handles.test.mjs for the provider's own dedicated plan-
// unit/e2e coverage; this test's job is narrower: prove the CLI's provider dispatch actually
// reaches python-fastapi for a python-fastapi-scanned feature (never misattributes to java-spring,
// never writes .java, never shows the Spring-specific error), using this file's own existing
// fixture/workflow helpers rather than a second copy of them.
test('handles plan/emit against a python-fastapi-scanned feature dispatches to the python-fastapi provider, generates a resolver for Item, and passes the handles gate', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughScan(root, '001-item-management', 'item');
	const docPath = writeOpenApiDoc(root);
	run(['contract', 'emit', '--feature', '001-item-management', '--module', 'items', '--openapi-file', docPath, '--path-prefix', '/api/v1'], root);

	const plan = run(['handles', 'plan', '--feature', '001-item-management', '--module', 'items', '--json'], root);
	assert.equal(plan.code, 0);
	const planJson = JSON.parse(plan.stdout);
	assert.equal(planJson.provider, 'python-fastapi');
	const itemResource = planJson.resources.find((r) => r.type === 'Item');
	assert.ok(itemResource, 'expected an Item resource in the plan');
	assert.equal(itemResource.willGenerateResolver, true, `Item should generate a resolver -- notes: ${JSON.stringify(planJson.notes)}`);

	const emit = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items'], root);
	assert.equal(emit.code, 0, emit.stderr);
	assert.ok(!(emit.stderr ?? '').includes('is this a Spring Boot project?'));

	const resolverPath = path.join(root, 'backend', 'app', 'handles', 'resolvers', 'item.py');
	assert.ok(fs.existsSync(resolverPath), 'expected backend/app/handles/resolvers/item.py to be written');
	// G4 follow-up (D-handles-providers): python-fastapi now generates a real migration.sql,
	// mirroring java-spring's own O4 work.
	assert.ok(fs.existsSync(path.join(root, 'specs', '001-item-management', 'handles', 'migration.sql')), 'python-fastapi now generates migration.sql (G4 follow-up)');

	const gate = run(['gate', 'require', 'handles', '--feature', '001-item-management'], root);
	assert.equal(gate.code, 0);

	const javaFiles = execFileSync('find', [root, '-name', '*.java'], { encoding: 'utf8' }).trim();
	assert.equal(javaFiles, '', 'no .java file should ever be written for a python-fastapi-scanned feature');
});
