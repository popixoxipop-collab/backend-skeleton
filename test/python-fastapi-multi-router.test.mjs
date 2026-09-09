// D-fastapi-multi-router-per-file: a real dogfooding find against `polarsource/polar` (a 400+
// route production FastAPI monorepo, see CATALOG.md). 3 real files declare MORE THAN ONE
// `<var> = APIRouter(...)` in the same source file (e.g. `member/endpoints.py`'s
// `router = APIRouter(prefix="/members")` plus a second, distinct
// `customer_members_router = APIRouter(prefix="/customers")` for a nested customer-scoped
// resource). Before this fix, `extractBasePath()` read only the FIRST `APIRouter(` occurrence in a
// file and applied that single basePath to every decorator in the file regardless of which router
// variable actually decorates it -- silently discarding the second router's own real prefix.
// A dedicated fixture/test file (not folded into python-fastapi-cli.test.mjs's existing single-
// router fixture) -- zero regression risk to the existing extraction-fidelity tests, which already
// re-ran green against this fix (30/30, byte-identical assertions).
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-fastapi-multirouter-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

	fs.mkdirSync(path.join(root, 'app', 'routes'), { recursive: true });
	fs.writeFileSync(path.join(root, 'app', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'app', 'routes', '__init__.py'), '');

	fs.writeFileSync(path.join(root, 'pyproject.toml'), `
[project]
name = "fixture-backend"
dependencies = [
    "fastapi[standard]>=0.141.1,<1.0.0",
]
`);

	// member.py: mirrors the real polar/member/endpoints.py shape -- two independently-prefixed
	// APIRouter() objects in one file. `router` (the default/conventional name) keeps the member
	// resource itself; `customer_members_router` is a SECOND, later-declared router for a nested
	// customer-scoped resource with its own distinct prefix.
	fs.writeFileSync(path.join(root, 'app', 'routes', 'member.py'), `
from fastapi import APIRouter

router = APIRouter(prefix="/members", tags=["members"])

customer_members_router = APIRouter(prefix="/customers", tags=["customers", "members"])


@router.get("/")
def list_members():
    pass


@router.post("/")
def create_member():
    pass


@customer_members_router.get("/{id}/members")
def list_customer_members(id: str):
    pass


@customer_members_router.post("/{id}/members")
def add_customer_member(id: str):
    pass
`);

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-fastapi-multirouter-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('a file with two APIRouter() declarations produces two controllers, each with its OWN prefix -- the second router no longer inherits the first one\'s basePath', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'member,customer', '--json'], root);
	assert.equal(scan.code, 0, scan.stderr);
	const report = JSON.parse(scan.stdout);
	const memberModule = report.related_modules.find((m) => m.module === 'member');
	assert.ok(memberModule, 'expected a "member" module');
	assert.equal(memberModule.controllers.length, 2, 'one controller per declared router variable, not one merged controller');

	const byClassName = Object.fromEntries(memberModule.controllers.map((c) => [c.className, c]));

	// the conventionally-named "router" variable keeps the pre-existing className convention exactly.
	assert.ok(byClassName.MemberRouter, 'default "router" variable keeps the ${capitalize(moduleName)}Router convention');
	assert.equal(byClassName.MemberRouter.basePath, '/members');
	assert.equal(byClassName.MemberRouter.endpoints.length, 2);
	assert.deepEqual(byClassName.MemberRouter.endpoints.map((e) => e.path).sort(), ['/members', '/members']);

	// the second, distinctly-named router gets its OWN correct prefix -- this is the actual bug fix.
	assert.ok(byClassName.CustomerMembersRouter, 'second router variable gets a distinguishing className derived from its own identifier');
	assert.equal(byClassName.CustomerMembersRouter.basePath, '/customers');
	assert.equal(byClassName.CustomerMembersRouter.endpoints.length, 2);
	assert.deepEqual(byClassName.CustomerMembersRouter.endpoints.map((e) => e.path).sort(), ['/customers/{id}/members', '/customers/{id}/members']);
});

test('verbs and methods on the second router are extracted correctly, not just its basePath', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'member,customer', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const memberModule = report.related_modules.find((m) => m.module === 'member');
	const custController = memberModule.controllers.find((c) => c.className === 'CustomerMembersRouter');
	const byMethod = Object.fromEntries(custController.endpoints.map((e) => [e.method, e]));
	assert.equal(byMethod.list_customer_members.verb, 'GET');
	assert.equal(byMethod.add_customer_member.verb, 'POST');
});
