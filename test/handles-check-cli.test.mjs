// D4 (D-handles-dryrun): `handles emit --check`/`--diff` and `handles plan --diff` -- a dry,
// never-writing preview of exactly what a real `handles emit` would do, backed by the same
// classifyFile()-derived `actions` emitUnits() now always computes. Java-spring fixture/workflow
// helpers copied from test/handles-cli.test.mjs (same convention every CLI test file already
// follows -- each owns its own fixture builder, not a shared import).
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-check-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	const base = 'com/example';
	const widgetDomain = path.join(root, 'src/main/java', base, 'domain/widget');
	fs.mkdirSync(path.join(widgetDomain, 'presentation'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'domain'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'application'), { recursive: true });
	fs.mkdirSync(path.join(root, 'src/main/java', base), { recursive: true });

	fs.writeFileSync(path.join(root, 'src/main/java', base, 'ExampleApplication.java'), 'package com.example;\npublic class ExampleApplication {}\n');
	fs.writeFileSync(path.join(widgetDomain, 'presentation', 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.security.access.prepost.PreAuthorize;

@PreAuthorize("hasRole('SUPER_ADMIN')")
@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {
	@Operation(operationId = "findWidget")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
}
`);
	fs.writeFileSync(path.join(widgetDomain, 'domain', 'Widget.java'), `
package com.example.domain.widget.domain;
import jakarta.persistence.*;
@Entity
@Table(name = "widget")
public class Widget {
	@Id
	private java.util.UUID widgetId;
}
`);
	fs.writeFileSync(path.join(widgetDomain, 'application', 'WidgetService.java'), `
package com.example.domain.widget.application;
public interface WidgetService {
	Object findWidget(java.util.UUID id);
}
`);

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-check-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runWorkflowThroughContract(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
}

const RESOLVER_REL = 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java';
const MANIFEST_REL = '.sbf/handles-manifest.json';
const CONTROLLER_REL = 'src/main/java/com/example/domain/widget/presentation/WidgetController.java';

test('handles emit --check on a fresh feature reports all 12 create actions, exits CHECK_FAILED, and writes nothing', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--json'], root);
	assert.equal(result.code, 1);
	const body = JSON.parse(result.stdout);
	assert.equal(body.check, true);
	assert.equal(body.blocked, false);
	assert.equal(body.gate, null, 'a dry run must never mark the handles gate passed');
	assert.equal(body.actions.length, 12);
	assert.ok(body.actions.every((a) => a.action === 'create'));

	assert.ok(!fs.existsSync(path.join(root, RESOLVER_REL)), '--check must not write the resolver');
	assert.ok(!fs.existsSync(path.join(root, MANIFEST_REL)), '--check must not create the ownership manifest');
	// specs/001-widget-management/contracts/ already exists from `contract emit` (an earlier,
	// real step of the workflow) -- the migration.sql that handles emit --check would create
	// under a SIBLING specs/.../handles/ dir is the thing that must specifically not appear.
	assert.ok(!fs.existsSync(path.join(root, 'specs', '001-widget-management', 'handles', 'migration.sql')), '--check must not write specs/.../handles/migration.sql');
	assert.equal(run(['gate', 'require', 'handles', '--feature', '001-widget-management'], root).code, 2, 'the handles gate must still read as not-run');
});

test('handles plan --diff shows the same file-action preview as --check, without ever calling emit', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['handles', 'plan', '--feature', '001-widget-management', '--diff', '--json'], root);
	assert.equal(result.code, 0, 'handles plan itself is purely informational, never a CI gate');
	const body = JSON.parse(result.stdout);
	assert.equal(body.actions.length, 12);
	assert.ok(body.actions.every((a) => a.action === 'create'));
	assert.ok(!fs.existsSync(path.join(root, MANIFEST_REL)), 'handles plan --diff must not write anything either');
});

test('handles emit --check after a real emit reports everything unchanged and exits OK, including the spec-owned migration.sql', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	assert.equal(run(['handles', 'emit', '--feature', '001-widget-management'], root).code, 0);

	const manifestBefore = fs.readFileSync(path.join(root, MANIFEST_REL), 'utf8');
	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--json'], root);
	assert.equal(result.code, 0, 'a fully up-to-date repo must report OK even though migration.sql always appears in written[] (P4-era quirk) -- exit code must be derived from actions, not written.length');
	const body = JSON.parse(result.stdout);
	assert.ok(body.actions.every((a) => a.action === 'unchanged'));

	const specAction = body.actions.find((a) => a.kind === 'spec');
	assert.ok(specAction, 'migration.sql must be reported with kind "spec"');
	assert.equal(specAction.path, 'specs/001-widget-management/handles/migration.sql');
	assert.deepEqual(body.actions.filter((a) => a.kind === 'infra').length, 10);
	assert.equal(body.actions.find((a) => a.kind === 'resolver')?.resourceType, 'Widget');

	assert.equal(fs.readFileSync(path.join(root, MANIFEST_REL), 'utf8'), manifestBefore, '--check must not touch the manifest even when nothing changed');
});

test('a hand-edited generated file makes --check report a conflict and exit HANDLES_CONFLICT (15), same as a real blocked emit, without overwriting the edit', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const resolverPath = path.join(root, RESOLVER_REL);
	const original = fs.readFileSync(resolverPath, 'utf8');
	fs.appendFileSync(resolverPath, '\n// hand edit\n');

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--json'], root);
	assert.equal(result.code, 15);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, true);
	assert.equal(body.conflicts.length, 1);
	assert.equal(body.conflicts[0].path, RESOLVER_REL);

	assert.ok(fs.readFileSync(resolverPath, 'utf8').includes('hand edit'), '--check must never overwrite a real conflict, even to "resolve" it');

	// A real emit (no --check) reaches the identical exit code for the identical reason -- --check
	// is a preview of the true verdict, not a softer approximation of it.
	const real = run(['handles', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(real.code, 15);
	fs.writeFileSync(resolverPath, original);
});

test('handles emit --check --diff shows a real unified diff for a live-derived value change (requiredAuthority), and never writes it', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const controllerPath = path.join(root, CONTROLLER_REL);
	const controllerSrc = fs.readFileSync(controllerPath, 'utf8');
	fs.writeFileSync(controllerPath, controllerSrc.replace("hasRole('SUPER_ADMIN')", "hasRole('WIDGET_ADMIN')"));

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--diff', '--json'], root);
	assert.equal(result.code, 1, 'a real, live-derived content change must fail --check');
	const body = JSON.parse(result.stdout);
	const resolverAction = body.actions.find((a) => a.kind === 'resolver');
	assert.equal(resolverAction.action, 'update');
	assert.match(resolverAction.diff, /-\t*return "SUPER_ADMIN";/);
	assert.match(resolverAction.diff, /\+\t*return "WIDGET_ADMIN";/);

	assert.match(fs.readFileSync(path.join(root, RESOLVER_REL), 'utf8'), /SUPER_ADMIN/, '--check --diff must not write the resolver, even though it computed what the new content would be');

	// handles plan --diff must show the identical diff without ever running emit.
	const planResult = run(['handles', 'plan', '--feature', '001-widget-management', '--diff', '--json'], root);
	const planAction = JSON.parse(planResult.stdout).actions.find((a) => a.kind === 'resolver');
	assert.equal(planAction.diff, resolverAction.diff);
});

test('handles emit --check without --diff never computes diff text (actions carry no .diff field)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const controllerPath = path.join(root, CONTROLLER_REL);
	fs.writeFileSync(controllerPath, fs.readFileSync(controllerPath, 'utf8').replace("hasRole('SUPER_ADMIN')", "hasRole('WIDGET_ADMIN')"));

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--json'], root);
	assert.equal(result.code, 1);
	const body = JSON.parse(result.stdout);
	const resolverAction = body.actions.find((a) => a.kind === 'resolver');
	assert.equal(resolverAction.action, 'update');
	assert.equal(resolverAction.diff, undefined);
});

test('a real handles emit is completely unaffected by D4 -- writes exactly as before, and its JSON gains only an additive actions field', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const body = JSON.parse(result.stdout);
	assert.equal(body.gate.status, 'pass');
	assert.equal(body.written.length, 12);
	assert.ok(Array.isArray(body.actions) && body.actions.length === 12, 'a real (non---check) emit also gets the actions field for free, purely additive');
	assert.ok(fs.existsSync(path.join(root, RESOLVER_REL)));
});

// python-fastapi has no outputs.spec (no migration.sql, no always-regenerated files) -- confirms
// the `kind: 'spec'` category and the written-vs-actions exit-code distinction are java-spring-
// specific quirks, not something --check spuriously invents for a provider that has none.
// Fixture/workflow copied from test/python-fastapi-cli.test.mjs's own conventions.
function buildPythonFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-check-py-fixture-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-check-py-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('handles emit --check for python-fastapi (no outputs.spec) exits OK once up to date, with zero "spec"-kind actions', () => {
	const root = buildPythonFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'item-management'], root);
	run(['scan', '--feature', '001-item-management', '--terms', 'item', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-item-management', '--mode', 'extend', '--note', 'test'], root);
	const docPath = path.join(root, 'openapi.json');
	fs.writeFileSync(docPath, JSON.stringify({ openapi: '3.1.0', paths: { '/api/v1/items/{id}': { get: { operationId: 'items-read_item', responses: {} } } } }));
	run(['contract', 'emit', '--feature', '001-item-management', '--module', 'items', '--openapi-file', docPath, '--path-prefix', '/api/v1'], root);

	const fresh = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--check', '--json'], root);
	assert.equal(fresh.code, 1);
	const freshBody = JSON.parse(fresh.stdout);
	assert.ok(freshBody.actions.every((a) => a.kind !== 'spec'), 'python-fastapi must never produce a spec-kind action');

	assert.equal(run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items'], root).code, 0);

	const upToDate = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--check', '--json'], root);
	assert.equal(upToDate.code, 0);
	assert.ok(JSON.parse(upToDate.stdout).actions.every((a) => a.action === 'unchanged'));
});
