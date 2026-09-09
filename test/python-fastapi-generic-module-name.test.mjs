// D-fastapi-generic-module-name: real dogfooding against `polarsource/polar` found the existing
// `moduleName = path.basename(file, '.py')` rule collapses to the literal string `"endpoints"`/
// `"router"` for every file using a real, common FastAPI convention -- name every router file
// generically, carry the real domain identity in the PARENT DIRECTORY instead
// (`organization/endpoints.py`). 57 real files were literally named `endpoints.py` in that repo, 1
// `router.py`. A naive "always use the parent directory name" fix creates real collisions (9 found
// in polar alone) with an unrelated, already-correctly-named file elsewhere in the repo -- this
// file covers the collision-safe two-pass resolution (`resolveGenericModuleNames()`), not just the
// happy path. A dedicated fixture/test file (not folded into python-fastapi-cli.test.mjs's existing
// items/login fixture, neither of which uses a generic basename) -- zero regression risk.
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

function buildFixtureRepo({ includeCollision = false, includeEntity = false } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-fastapi-generic-module-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

	fs.mkdirSync(path.join(root, 'app', 'organization'), { recursive: true });
	fs.writeFileSync(path.join(root, 'app', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'app', 'organization', '__init__.py'), '');

	fs.writeFileSync(path.join(root, 'pyproject.toml'), `
[project]
name = "fixture-backend"
dependencies = [
    "fastapi[standard]>=0.141.1,<1.0.0",
    "sqlmodel>=0.0.24",
]
`);

	// mirrors polar's real convention: the router file itself is named generically, the real
	// domain identity ("organization") lives in the parent directory.
	fs.writeFileSync(path.join(root, 'app', 'organization', 'endpoints.py'), `
from fastapi import APIRouter

router = APIRouter(prefix="/organizations", tags=["organizations"])


@router.get("/")
def list_organizations():
    pass


@router.get("/{id}")
def get_organization(id: str):
    pass
`);

	if (includeCollision) {
		// mirrors polar's real customer_portal/endpoints/organization.py -- a DIFFERENT, already
		// correctly-named file whose own basename happens to equal the candidate directory name
		// above. The two must NOT be merged into one module bucket.
		fs.mkdirSync(path.join(root, 'app', 'customer_portal'), { recursive: true });
		fs.writeFileSync(path.join(root, 'app', 'customer_portal', '__init__.py'), '');
		fs.writeFileSync(path.join(root, 'app', 'customer_portal', 'organization.py'), `
from fastapi import APIRouter

router = APIRouter(prefix="/customer-portal/organizations", tags=["customer-portal"])


@router.get("/")
def portal_list_organizations():
    pass
`);
	}

	if (includeEntity) {
		// mirrors polar's real layout: SQLModel table entities live in a fully separate, centralized
		// models package, never co-located with their router file.
		fs.mkdirSync(path.join(root, 'app', 'models'), { recursive: true });
		fs.writeFileSync(path.join(root, 'app', 'models', '__init__.py'), '');
		fs.writeFileSync(path.join(root, 'app', 'models', 'organization.py'), `
from sqlmodel import Field, SQLModel
import uuid


class Organization(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str
`);
	}

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-fastapi-generic-module-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('win case: a generic endpoints.py resolves its module to the real domain name (parent directory), not the literal "endpoints"', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'organization', '--json'], root);
	assert.equal(scan.code, 0, scan.stderr);
	const report = JSON.parse(scan.stdout);
	const moduleNames = report.related_modules.map((m) => m.module);
	assert.ok(moduleNames.includes('organization'), `expected an "organization" module, got: ${moduleNames.join(', ')}`);
	assert.ok(!moduleNames.includes('endpoints'), 'the generic literal name "endpoints" should not survive when a real domain name is available');
});

test('collision case: a generic file whose candidate name collides with an already-correctly-named file keeps the OLD literal name instead of merging', () => {
	const root = buildFixtureRepo({ includeCollision: true });
	const scan = run(['scan', '--terms', 'organization,customer', '--json'], root);
	assert.equal(scan.code, 0, scan.stderr);
	const report = JSON.parse(scan.stdout);

	// the non-generic file (customer_portal/organization.py) keeps its reserved literal name.
	const orgModule = report.related_modules.find((m) => m.module === 'organization');
	assert.ok(orgModule, 'expected the reserved "organization" module (from the non-generic file)');
	assert.ok(orgModule.controllers.some((c) => c.endpoints.some((e) => e.method === 'portal_list_organizations')), 'the reserved "organization" module should be the customer-portal file, not the generic one');

	// the generic file (organization/endpoints.py) falls back to the old literal name -- NOT merged
	// into "organization" alongside the unrelated customer-portal controller.
	const endpointsModule = report.related_modules.find((m) => m.module === 'endpoints');
	assert.ok(endpointsModule, 'expected the generic file to fall back to "endpoints" on collision');
	assert.ok(endpointsModule.controllers.some((c) => c.endpoints.some((e) => e.method === 'list_organizations')), 'the fallback "endpoints" module should be the generic organization/endpoints.py file');

	// neither controller was silently merged into the other's bucket.
	assert.equal(orgModule.controllers.flatMap((c) => c.endpoints).length, 1);
	assert.equal(endpointsModule.controllers.flatMap((c) => c.endpoints).length, 2);
});

test('entity case: a real SQLModel table entity in a centralized models/ package now correctly attaches to its router\'s renamed module, not the _models fallback', () => {
	const root = buildFixtureRepo({ includeEntity: true });
	const scan = run(['scan', '--terms', 'organization', '--json'], root);
	assert.equal(scan.code, 0, scan.stderr);
	const report = JSON.parse(scan.stdout);
	const orgModule = report.related_modules.find((m) => m.module === 'organization');
	assert.ok(orgModule, 'expected an "organization" module');
	assert.ok(orgModule.entities.some((e) => e.className === 'Organization'), 'the Organization entity should attach to the renamed "organization" module');

	const modelsModule = report.related_modules.find((m) => m.module === '_models');
	assert.ok(!modelsModule || !modelsModule.entities.some((e) => e.className === 'Organization'), 'Organization must not fall into the _models unmatched bucket now that its real module is discoverable');
});
