// D-runtime-conformance-receipts: end-to-end CLI coverage for `bskel observe emit --module ...`
// against the python-fastapi provider. Fixture copied from test/python-fastapi-handles.test.mjs's
// own buildOpenApiFixtureRepo() -- --openapi-file is required the same way it was for that file's
// own D-resolver-policy-split regression test, since python-fastapi's scanned operationId is
// always null (D-fastapi-adapter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');
const FEATURE_ID = '001-item-management';

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function buildOpenApiFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-emit-py-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-emit-py-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runWorkflowThroughContract(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'item-management'], root);
	run(['scan', '--feature', FEATURE_ID, '--terms', 'item', '--json'], root);
	run(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'extend', '--note', 'test'], root);
	// D-cli-contract convention (matching test/python-fastapi-handles.test.mjs's own fixture):
	// openapi.json is written AFTER preflight, not before -- an untracked file at repo root would
	// otherwise make preflight's own dirty-tree check fail.
	const openApiPath = path.join(root, 'openapi.json');
	fs.writeFileSync(openApiPath, JSON.stringify({
		openapi: '3.1.0',
		paths: { '/api/v1/items/{id}': { get: { operationId: 'items-read_item', responses: {} } } },
	}));
	run(['contract', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--openapi-file', openApiPath, '--path-prefix', '/api/v1'], root);
}

const OBSERVE_DIR = 'backend/app/observe';
const OBSERVED_SCHEMA_PATH = `${OBSERVE_DIR}/schemas/${FEATURE_ID}.observed-schema.json`;

test('observe emit --module items is blocked before the contract gate has passed', () => {
	const root = buildOpenApiFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'item-management'], root);
	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'items'], root);
	assert.equal(result.code, 2);
});

test('observe emit writes the three python infra modules plus the projected observed-schema.json, and never touches handles/ output', () => {
	const root = buildOpenApiFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, false);
	assert.deepEqual(
		body.written.slice().sort(),
		[
			`${OBSERVE_DIR}/__init__.py`,
			`${OBSERVE_DIR}/observed_schema.py`,
			`${OBSERVE_DIR}/contract_check.py`,
			`${OBSERVE_DIR}/observe_contract.py`,
			OBSERVED_SCHEMA_PATH,
		].sort(),
	);
	for (const f of ['__init__.py', 'observed_schema.py', 'contract_check.py', 'observe_contract.py']) {
		assert.ok(fs.existsSync(path.join(root, OBSERVE_DIR, f)), `expected ${f} to exist`);
	}
	assert.ok(!fs.existsSync(path.join(root, 'backend/app/handles')), 'observe emit must never write anything handles emit owns');

	const schema = JSON.parse(fs.readFileSync(path.join(root, OBSERVED_SCHEMA_PATH), 'utf8'));
	assert.equal(schema.sbf_observed_schema, '1');
	assert.equal(schema.feature_id, FEATURE_ID);
	assert.ok(schema.operations['items-read_item']);
	assert.equal(schema.operations['items-read_item'].verb, 'GET');
	assert.deepEqual(schema.operations['items-read_item'].pathParams.required, ['id']);
});

test('observe emit --module items is idempotent -- re-running rewrites nothing except the always-regenerated observed-schema.json', () => {
	const root = buildOpenApiFixtureRepo();
	runWorkflowThroughContract(root);
	run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'items'], root);
	const before = fs.readFileSync(path.join(root, OBSERVE_DIR, 'contract_check.py'), 'utf8');

	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--json'], root);
	assert.equal(result.code, 0);
	const body = JSON.parse(result.stdout);
	assert.deepEqual(body.written, [OBSERVED_SCHEMA_PATH]);
	assert.ok(body.actions.every((a) => a.action === 'unchanged'));
	assert.equal(fs.readFileSync(path.join(root, OBSERVE_DIR, 'contract_check.py'), 'utf8'), before);
});

test('hand-editing a generated observe infra module then re-running exits 15 and leaves the file byte-for-byte untouched', () => {
	const root = buildOpenApiFixtureRepo();
	runWorkflowThroughContract(root);
	run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'items'], root);

	const checkPath = path.join(root, OBSERVE_DIR, 'contract_check.py');
	const edited = `${fs.readFileSync(checkPath, 'utf8')}\n# hand edit\n`;
	fs.writeFileSync(checkPath, edited);

	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--json'], root);
	assert.equal(result.code, 15);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, true);
	assert.ok(body.conflicts.some((c) => c.path === `${OBSERVE_DIR}/contract_check.py`));
	assert.equal(fs.readFileSync(checkPath, 'utf8'), edited);
});

test('observe emit --check --diff previews without writing, and reports CHECK_FAILED on a fresh feature', () => {
	const root = buildOpenApiFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--check', '--diff', '--json'], root);
	assert.equal(result.code, 1);
	const body = JSON.parse(result.stdout);
	assert.ok(body.actions.every((a) => a.action === 'create'));
	assert.ok(!fs.existsSync(path.join(root, OBSERVE_DIR, 'contract_check.py')), '--check must not write anything');
	assert.ok(!fs.existsSync(path.join(root, OBSERVED_SCHEMA_PATH)));
});
