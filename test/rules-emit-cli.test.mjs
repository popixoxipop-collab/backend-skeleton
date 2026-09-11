// D-business-rules (R9): end-to-end CLI coverage for `bskel rules emit` (java-spring v1). Fixture
// builder mirrors test/observe-emit-cli.test.mjs's own conventions exactly -- rules emit needs
// real detectBasePackage() input the same way observe emit does, so this file cannot reuse
// test/_contract-fixture.mjs's buildFixtureRepo() (which deliberately has no *Application.java).
// Real-JVM proof that the generated code actually compiles and executes correctly lives in
// scripts/java-compile-smoke.mjs -- this file's job is cheap, always-run coverage of the WIRING:
// gating, output paths, idempotence, and unsupported-adapter refusal.
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rules-emit-fixture-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rules-emit-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runWorkflowThroughRules(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['rules', 'check', '--feature', '001-widget-management'], root);
}

const RULES_DIR = 'src/main/java/com/example/global/rules';
const RULES_RESOURCE_PATH = 'src/main/resources/bskel/001-widget-management.rules.json';

test('rules emit is blocked before the rules gate has passed', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	// deliberately skips `rules check`
	const result = run(['rules', 'emit', '--feature', '001-widget-management'], root);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /`rules` gate/);
	assert.match(result.stderr, /run `bskel rules check --feature 001-widget-management` first/);
});

test('rules emit writes the four infra templates plus the compiled rules.json', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughRules(root);

	const result = run(['rules', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, false);
	assert.deepEqual(
		body.written.slice().sort(),
		[
			`${RULES_DIR}/RuleSetLoader.java`,
			`${RULES_DIR}/RuleCheck.java`,
			`${RULES_DIR}/EnforceRules.java`,
			`${RULES_DIR}/RuleEnforcementAspect.java`,
			RULES_RESOURCE_PATH,
		].sort(),
	);
	for (const f of ['RuleSetLoader.java', 'RuleCheck.java', 'EnforceRules.java', 'RuleEnforcementAspect.java']) {
		assert.ok(fs.existsSync(path.join(root, RULES_DIR, f)), `expected ${f} to exist`);
	}
	assert.ok(!fs.existsSync(path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java')), 'rules emit must never write anything handles emit owns');
	assert.ok(!fs.existsSync(path.join(root, 'src/main/resources/bskel/001-widget-management.observed-schema.json')), 'rules emit must never write anything observe emit owns');

	const artifact = JSON.parse(fs.readFileSync(path.join(root, RULES_RESOURCE_PATH), 'utf8'));
	assert.equal(artifact.sbf_feature_rules, '1');
	assert.equal(artifact.feature_id, '001-widget-management');

	// The emitted resource is byte-identical to what `rules check` already wrote and validated --
	// deliberately one representation of these rules, never re-serialized on the way to the
	// classpath (see rules.mjs's own comment).
	const checked = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/rules/001-widget-management.rules.json'), 'utf8'));
	assert.deepEqual(artifact, checked);
});

test('the rejection/redaction/auto-wiring contract is documented on the generated EnforceRules/RuleEnforcementAspect javadoc', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughRules(root);
	run(['rules', 'emit', '--feature', '001-widget-management'], root);

	const aspect = fs.readFileSync(path.join(root, RULES_DIR, 'RuleEnforcementAspect.java'), 'utf8');
	assert.match(aspect, /bskel\.rules\.mode/);
	assert.match(aspect, /default \{@code "observe"\}/);
	assert.match(aspect, /HTTP 400/);
	assert.match(aspect, /NEVER contains an observed/);

	const annotation = fs.readFileSync(path.join(root, RULES_DIR, 'EnforceRules.java'), 'utf8');
	assert.match(annotation, /Does not check TRANSITION rules/);
});

test('a second rules emit with nothing changed leaves every file unchanged (idempotent, matches handles/observe emit\'s own invariant)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughRules(root);
	run(['rules', 'emit', '--feature', '001-widget-management'], root);
	const before = {};
	for (const f of ['RuleSetLoader.java', 'RuleCheck.java', 'EnforceRules.java', 'RuleEnforcementAspect.java']) {
		before[f] = fs.readFileSync(path.join(root, RULES_DIR, f), 'utf8');
	}

	const result = run(['rules', 'emit', '--feature', '001-widget-management', '--diff', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.ok(body.actions.every((a) => a.action === 'unchanged' || (a.kind === 'spec' && a.action === 'unchanged')), `expected every action unchanged, got: ${JSON.stringify(body.actions)}`);

	for (const f of ['RuleSetLoader.java', 'RuleCheck.java', 'EnforceRules.java', 'RuleEnforcementAspect.java']) {
		assert.equal(fs.readFileSync(path.join(root, RULES_DIR, f), 'utf8'), before[f], `${f} must be byte-identical after a no-op re-emit`);
	}
});

// A real python-fastapi-detected repo, not a synthetic one: python-fastapi's scanned operationId
// is always null (D-fastapi-adapter), so `--openapi-file` is required for contract emit here --
// the same fixture shape test/observe-emit-python-cli.test.mjs's own buildOpenApiFixtureRepo()
// already established for this exact problem.
function buildPythonFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rules-emit-py-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rules-emit-py-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('rules emit refuses an adapter it does not support yet, naming java-spring as the one that IS supported', () => {
	const root = buildPythonFixtureRepo();
	const FEATURE_ID = '001-item-management';
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'item-management'], root);
	run(['scan', '--feature', FEATURE_ID, '--terms', 'item', '--json'], root);
	run(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'extend', '--note', 'test'], root);
	// D-cli-contract convention: openapi.json written AFTER preflight, not before -- an untracked
	// file at repo root would otherwise make preflight's own dirty-tree check fail.
	const openApiPath = path.join(root, 'openapi.json');
	fs.writeFileSync(openApiPath, JSON.stringify({
		openapi: '3.1.0',
		paths: { '/api/v1/items/{id}': { get: { operationId: 'items-read_item', responses: {} } } },
	}));
	const contractResult = run(['contract', 'emit', '--feature', FEATURE_ID, '--module', 'items', '--openapi-file', openApiPath, '--path-prefix', '/api/v1'], root);
	assert.equal(contractResult.code, 0, `contract emit: ${contractResult.stderr ?? ''}`);
	const checkResult = run(['rules', 'check', '--feature', FEATURE_ID], root);
	assert.equal(checkResult.code, 0, `rules check: ${checkResult.stderr ?? ''}`);

	const result = run(['rules', 'emit', '--feature', FEATURE_ID], root);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /does not support the "python-fastapi" adapter yet \(supported: java-spring\)/);
	assert.match(result.stderr, /`bskel rules check` works for every adapter/);
});
