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
	// D-cross-feature-collision: single-feature fixture, always passes with 0 findings -- its token
	// only depends on cross-feature-report.json/resolution.json's own content (no `other_feature`
	// entries for a solo feature), so it stays passed through every later re-scan/re-contract-emit
	// this file's own tests perform (neither touches these two files).
	run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root);
}

const RESOLVER_REL = 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java';
// D-resolver-policy-split: the live-derived/security-relevant declarations live in this separate,
// always-safe-to-regenerate companion file -- see DECISIONS.md.
const POLICY_REL = 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolverPolicy.java';
const MANIFEST_REL = '.sbf/handles-manifest.json';
const CONTROLLER_REL = 'src/main/java/com/example/domain/widget/presentation/WidgetController.java';

test('handles emit --check on a fresh feature reports all 13 create actions, exits CHECK_FAILED, and writes nothing', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--json'], root);
	assert.equal(result.code, 1);
	const body = JSON.parse(result.stdout);
	assert.equal(body.check, true);
	assert.equal(body.blocked, false);
	assert.equal(body.gate, null, 'a dry run must never mark the handles gate passed');
	// D-resolver-policy-split: 10 infra + 2 resolver-kind units (Resolver + Policy) + 1 spec.
	assert.equal(body.actions.length, 13);
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
	assert.equal(body.actions.length, 13);
	assert.ok(body.actions.every((a) => a.action === 'create'));
	assert.ok(!fs.existsSync(path.join(root, MANIFEST_REL)), 'handles plan --diff must not write anything either');
});

test('handles emit --check after a real emit reports everything unchanged and exits OK, including the manifest-tracked migration.sql', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	assert.equal(run(['handles', 'emit', '--feature', '001-widget-management'], root).code, 0);

	const manifestBefore = fs.readFileSync(path.join(root, MANIFEST_REL), 'utf8');
	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--json'], root);
	assert.equal(result.code, 0, 'a fully up-to-date repo must report OK');
	const body = JSON.parse(result.stdout);
	assert.ok(body.actions.every((a) => a.action === 'unchanged'));

	// D-write-safety-phase0 (item 1): migration.sql moved off the always-regenerated 'spec' kind
	// onto real manifest tracking (kind: 'migration', ownership: 'feature') -- 'unchanged' here
	// means classifyFile() genuinely found matching content, not a hardcoded 3-way guess.
	const migrationAction = body.actions.find((a) => a.kind === 'migration');
	assert.ok(migrationAction, 'migration.sql must be reported with kind "migration"');
	assert.equal(migrationAction.path, 'specs/001-widget-management/handles/migration.sql');
	assert.deepEqual(body.actions.filter((a) => a.kind === 'infra').length, 10);
	// D-resolver-policy-split: two resolver-kind actions now (Resolver + Policy), both for Widget --
	// look up by path, not by kind alone, since kind:'resolver' is no longer unique per resource.
	const resolverActions = body.actions.filter((a) => a.kind === 'resolver');
	assert.equal(resolverActions.length, 2);
	assert.ok(resolverActions.every((a) => a.resourceType === 'Widget'));
	assert.ok(resolverActions.some((a) => a.path === RESOLVER_REL));
	assert.ok(resolverActions.some((a) => a.path === POLICY_REL));

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
	// S2 (D-gate-precision, parts 1+2): the controller is now one of the tracked files for BOTH
	// `scan` (Part 1, whole-adapter read-set) and `contract` (Part 2, the disposed module's own
	// files) -- editing it, even uncommitted, correctly stales both. Re-running the chain re-syncs
	// every token to the controller's current content without changing scan/contract's own OUTPUT
	// (authority/role isn't part of either's schema), which is exactly what lets `handles emit`
	// proceed to the live-diff logic this test actually wants to exercise.
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--diff', '--json'], root);
	assert.equal(result.code, 1, 'a real, live-derived content change must fail --check');
	const body = JSON.parse(result.stdout);

	// D-resolver-policy-split: this is the fix's proof point -- a requiredAuthority-only source
	// change must NOT stale WidgetResolver.java (no live-derived token lives there anymore, so its
	// fresh render is byte-identical) and must ONLY stale the companion WidgetResolverPolicy.java.
	// Before this fix, both were the same file and both showed the same diff, which meant a hand-
	// edited patchField() (a `conflict`, not `unchanged`) would block this legitimate role change too.
	const resolverAction = body.actions.find((a) => a.path === RESOLVER_REL);
	assert.equal(resolverAction.action, 'unchanged', 'Resolver.java must stay unchanged -- it has no live-derived-value tokens anymore');

	const policyAction = body.actions.find((a) => a.path === POLICY_REL);
	assert.equal(policyAction.action, 'update');
	assert.match(policyAction.diff, /-\t*return "ROLE_SUPER_ADMIN";/);
	assert.match(policyAction.diff, /\+\t*return "ROLE_WIDGET_ADMIN";/);

	assert.match(fs.readFileSync(path.join(root, POLICY_REL), 'utf8'), /ROLE_SUPER_ADMIN/, '--check --diff must not write the policy file, even though it computed what the new content would be');

	// handles plan --diff must show the identical diff without ever running emit.
	const planResult = run(['handles', 'plan', '--feature', '001-widget-management', '--diff', '--json'], root);
	const planActions = JSON.parse(planResult.stdout).actions;
	assert.equal(planActions.find((a) => a.path === RESOLVER_REL).action, 'unchanged');
	assert.equal(planActions.find((a) => a.path === POLICY_REL).diff, policyAction.diff);
});

test('handles emit --check without --diff never computes diff text (actions carry no .diff field)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const controllerPath = path.join(root, CONTROLLER_REL);
	fs.writeFileSync(controllerPath, fs.readFileSync(controllerPath, 'utf8').replace("hasRole('SUPER_ADMIN')", "hasRole('WIDGET_ADMIN')"));
	// S2 (D-gate-precision, parts 1+2): see the sibling --diff test above for why this is needed now.
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--check', '--json'], root);
	assert.equal(result.code, 1);
	const body = JSON.parse(result.stdout);
	const policyAction = body.actions.find((a) => a.path === POLICY_REL);
	assert.equal(policyAction.action, 'update');
	assert.equal(policyAction.diff, undefined);
});

test('a real handles emit is completely unaffected by D4 -- writes exactly as before, and its JSON gains only an additive actions field', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const body = JSON.parse(result.stdout);
	assert.equal(body.gate.status, 'pass');
	assert.equal(body.written.length, 13);
	assert.ok(Array.isArray(body.actions) && body.actions.length === 13, 'a real (non---check) emit also gets the actions field for free, purely additive');
	assert.ok(fs.existsSync(path.join(root, RESOLVER_REL)));
	assert.ok(fs.existsSync(path.join(root, POLICY_REL)));
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

// G4 follow-up (D-handles-providers): python-fastapi declares outputs.spec (migration.sql,
// mirroring java-spring's own O4 work) -- this test's own name/premise used to be "no
// outputs.spec, must never produce a spec-kind action"; both halves are now the opposite.
// D-write-safety-phase0 (item 1): migration.sql itself moved off the 'spec' action-kind onto real
// manifest tracking ('migration', ownership: 'feature') -- outputs.spec is still declared (kept
// for lib/verify.mjs's S6 safety net, see the java-spring.mjs comment) but no longer determines
// this action's kind.
test('handles emit --check for python-fastapi (real outputs.spec, G4 follow-up) exits OK once up to date, with a real manifest-tracked migration.sql action', () => {
	const root = buildPythonFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'item-management'], root);
	run(['scan', '--feature', '001-item-management', '--terms', 'item', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-item-management', '--mode', 'extend', '--note', 'test'], root);
	const docPath = path.join(root, 'openapi.json');
	fs.writeFileSync(docPath, JSON.stringify({ openapi: '3.1.0', paths: { '/api/v1/items/{id}': { get: { operationId: 'items-read_item', responses: {} } } } }));
	run(['contract', 'emit', '--feature', '001-item-management', '--module', 'items', '--openapi-file', docPath, '--path-prefix', '/api/v1'], root);
	run(['scan', 'cross-feature-check', '--feature', '001-item-management'], root); // D-cross-feature-collision: single-feature fixture, always passes

	const fresh = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--check', '--json'], root);
	assert.equal(fresh.code, 1);
	const freshBody = JSON.parse(fresh.stdout);
	const migrationActions = freshBody.actions.filter((a) => a.kind === 'migration');
	assert.deepEqual(migrationActions.map((a) => a.path), ['specs/001-item-management/handles/migration.sql']);
	assert.equal(migrationActions[0].action, 'create');

	assert.equal(run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items'], root).code, 0);

	// D-write-safety-phase0 (item 1): migration.sql is manifest-tracked now (same mechanism as
	// resolvers_index.ts's own barrel) -- its action reports genuine 'unchanged' via classifyFile(),
	// same as every other action kind, not a hardcoded 3-way guess.
	const upToDate = run(['handles', 'emit', '--feature', '001-item-management', '--module', 'items', '--check', '--json'], root);
	assert.equal(upToDate.code, 0);
	assert.ok(JSON.parse(upToDate.stdout).actions.every((a) => a.action === 'unchanged'));
});
