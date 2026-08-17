// D-handles-providers (G4): unit tests for handles/registry.mjs (zero-registration codegen
// provider discovery), mirroring test/adapter-registry.test.mjs's structure exactly (same
// mkdtemp'd-directory-per-fixture, no repo mutation). See D-adapter-registry (G1) and
// D-handles-providers (G4) in DECISIONS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadProviders, providerById, PROVIDERS, PROVIDER_LOAD_ERRORS } from '../handles/registry.mjs';
import { ADAPTERS } from '../scanners/registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');

function tmpProvidersDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-provider-registry-'));
}

function writeProvider(dir, filename, source) {
	fs.writeFileSync(path.join(dir, filename), source);
}

// A minimal, always-valid provider body -- individual tests override just the fields under test.
function fixtureSource({ id = 'zzz-fixture', contract = "'sbf.handles-provider/1'", requiresCapabilities = "['resource.fetch']", outputsSpec = '[]' } = {}) {
	return `
export const provider = {
  contract: ${contract},
  id: '${id}',
  title: 'Fixture provider',
  requiresCapabilities: ${requiresCapabilities},
  outputs: { spec: ${outputsSpec} },
  plan({ repoRoot, scanReport, module, resourceFilter }) {
    return { schema: 'sbf.handles-plan/1', provider: '${id}', module: null, resources: [], notes: [] };
  },
  emit({ repoRoot, featureId, plan, resourceFilter, force, reason }) {
    return { written: [], resolverStubs: [], conflicts: [], orphans: [], notes: [], forced: [], blocked: false };
  },
};
`;
}

test('real registry: loads exactly java-spring and python-fastapi, no load errors', async () => {
	assert.deepEqual(PROVIDER_LOAD_ERRORS, []);
	assert.deepEqual([...PROVIDERS.map((p) => p.id)].sort(), ['java-spring', 'python-fastapi']);
});

test('zero-registration: a well-formed provider file dropped into a directory is discovered with no other edit', async () => {
	const dir = tmpProvidersDir();
	writeProvider(dir, 'zzz-fixture.mjs', fixtureSource());
	const { providers, errors } = await loadProviders({ providersDir: dir });
	assert.deepEqual(errors, []);
	assert.equal(providers.length, 1);
	assert.equal(providers[0].id, 'zzz-fixture');
});

test('no arbitration: provider selection is exact id match, not specificity -- both fixture providers with the same id-space just coexist', async () => {
	const dir = tmpProvidersDir();
	writeProvider(dir, 'aaa.mjs', fixtureSource({ id: 'aaa' }));
	writeProvider(dir, 'bbb.mjs', fixtureSource({ id: 'bbb' }));
	const { providers } = await loadProviders({ providersDir: dir });
	assert.equal(providerById(providers, 'aaa').id, 'aaa');
	assert.equal(providerById(providers, 'bbb').id, 'bbb');
	assert.equal(providerById(providers, 'ccc'), null);
});

test('malformed providers: each failure mode is collected in errors naming its file, and valid siblings still load', async () => {
	const dir = tmpProvidersDir();
	writeProvider(dir, 'good.mjs', fixtureSource({ id: 'good' }));
	writeProvider(dir, 'no-export.mjs', 'export const somethingElse = {};\n');
	writeProvider(dir, 'id-mismatch.mjs', fixtureSource({ id: 'wrong-name' }));
	writeProvider(dir, 'bad-version.mjs', fixtureSource({ id: 'bad-version', contract: "'sbf.handles-provider/99'" }));
	writeProvider(dir, 'bad-capability.mjs', fixtureSource({ id: 'bad-capability', requiresCapabilities: "['not-a-real-capability']" }));
	writeProvider(dir, 'missing-emit.mjs', `
export const provider = {
  contract: 'sbf.handles-provider/1',
  id: 'missing-emit',
  title: 'Fixture provider',
  requiresCapabilities: ['resource.fetch'],
  outputs: { spec: [] },
  plan({ repoRoot }) { return { schema: 'sbf.handles-plan/1', provider: 'missing-emit', module: null, resources: [], notes: [] }; },
};
`);
	writeProvider(dir, 'syntax-error.mjs', 'export const provider = {\n');

	const { providers, errors } = await loadProviders({ providersDir: dir });

	assert.equal(providers.length, 1);
	assert.equal(providers[0].id, 'good');
	assert.equal(errors.length, 6);
	const byFile = Object.fromEntries(errors.map((e) => [path.basename(e.file), e.message]));
	assert.match(byFile['no-export.mjs'], /export const provider/);
	assert.match(byFile['id-mismatch.mjs'], /must equal its filename/);
	assert.match(byFile['bad-version.mjs'], /sbf\.handles-provider\/99/);
	assert.match(byFile['bad-capability.mjs'], /does not match schemas\/handles-provider\.schema\.json/);
	assert.match(byFile['missing-emit.mjs'], /provider\.emit must be a function/);
	assert.match(byFile['syntax-error.mjs'], /failed to load/);
});

test('files prefixed with _ or . are skipped, not treated as malformed providers', async () => {
	const dir = tmpProvidersDir();
	writeProvider(dir, 'good.mjs', fixtureSource({ id: 'good' }));
	writeProvider(dir, '_shared-helper.mjs', 'this is not even valid JS on its own {{{');
	writeProvider(dir, '.hidden.mjs', 'also not valid JS {{{');
	const { providers, errors } = await loadProviders({ providersDir: dir });
	assert.deepEqual(errors, []);
	assert.equal(providers.length, 1);
	assert.equal(providers[0].id, 'good');
});

// The core promise this item's registry design rests on: `codegen.handles === true` for a shipped
// adapter must mean a real provider is loaded for that exact same id, and vice versa -- an
// adapter that lies about this (declares the capability with no provider, or ships a provider
// nobody's adapter opts into) would leave requireProviderCapabilitiesOrExit (bin/bskel.mjs) unable
// to ever recover cleanly. See D-handles-providers in DECISIONS.md.
test('biconditional: every shipped adapter\'s codegen.handles capability is true if and only if a provider with that exact id is loaded', () => {
	for (const adapter of ADAPTERS) {
		const hasProvider = providerById(PROVIDERS, adapter.id) !== null;
		assert.equal(
			adapter.capabilities['codegen.handles'], hasProvider,
			`adapter "${adapter.id}" declares codegen.handles=${adapter.capabilities['codegen.handles']} but a provider ${hasProvider ? 'exists' : 'does NOT exist'} for it`,
		);
	}
});

// S1-style drift guard, mirrored from adapter-registry.test.mjs's COMMAND_CAPABILITIES check --
// every capability a provider declares in requiresCapabilities must be a real capability name.
test('every capability referenced in a shipped provider\'s requiresCapabilities is a real declared capability', async () => {
	const { CAPABILITY_NAMES } = await import('../scanners/capabilities.mjs');
	for (const provider of PROVIDERS) {
		for (const cap of provider.requiresCapabilities) {
			assert.ok(CAPABILITY_NAMES.includes(cap), `provider "${provider.id}".requiresCapabilities references unknown capability '${cap}'`);
		}
	}
});

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function initGitRepo(root) {
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-provider-registry-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
}

function buildJavaSpringFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-provider-registry-java-'));
	const pkgDir = path.join(root, 'src', 'main', 'java', 'com', 'example');
	fs.mkdirSync(path.join(pkgDir, 'domain', 'widget', 'presentation'), { recursive: true });
	fs.mkdirSync(path.join(pkgDir, 'domain', 'widget', 'application'), { recursive: true });
	fs.mkdirSync(path.join(pkgDir, 'domain', 'widget', 'domain'), { recursive: true });
	fs.writeFileSync(path.join(root, 'build.gradle'), '');
	fs.writeFileSync(path.join(pkgDir, 'ExampleApplication.java'), `
package com.example;
public class ExampleApplication {}
`);
	fs.writeFileSync(path.join(pkgDir, 'domain', 'widget', 'presentation', 'WidgetController.java'), `
package com.example.domain.widget.presentation;
@RestController
@RequestMapping("/widgets")
public class WidgetController {
    @PreAuthorize("hasRole('ADMIN')")
    @Operation(operationId = "findWidget")
    @GetMapping("/{widgetId}")
    public WidgetResponse findWidget(@PathVariable UUID widgetId) { return null; }
}
`);
	fs.writeFileSync(path.join(pkgDir, 'domain', 'widget', 'domain', 'Widget.java'), `
package com.example.domain.widget.domain;
@Entity
@Table(name = "widget")
public class Widget {
    @Id
    private java.util.UUID id;
}
`);
	fs.writeFileSync(path.join(pkgDir, 'domain', 'widget', 'application', 'WidgetService.java'), `
package com.example.domain.widget.application;
public interface WidgetService {
    Widget findWidget(UUID widgetId);
}
`);
	initGitRepo(root);
	return root;
}

function buildPythonFastApiFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-provider-registry-python-'));
	fs.mkdirSync(path.join(root, 'backend', 'app', 'api'), { recursive: true });
	fs.writeFileSync(path.join(root, 'backend', 'app', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', '__init__.py'), '');
	fs.writeFileSync(path.join(root, 'backend', 'pyproject.toml'), '[project]\nname = "fixture"\ndependencies = ["fastapi>=0.100.0", "sqlmodel>=0.0.24"]\n');
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', 'deps.py'), `
from typing import Annotated
from fastapi import Depends
from sqlmodel import Session

def get_db(): pass

SessionDep = Annotated[Session, Depends(get_db)]
`);
	fs.writeFileSync(path.join(root, 'backend', 'app', 'api', 'items.py'), `
from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])

@router.get("/{id}", response_model=ItemPublic)
def read_item(session: SessionDep, id: str):
    pass
`);
	fs.writeFileSync(path.join(root, 'backend', 'app', 'models.py'), `
from sqlmodel import Field, SQLModel
import uuid

class Item(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)

class ItemPublic(SQLModel):
    id: uuid.UUID
`);
	initGitRepo(root);
	return root;
}

// Schema-accuracy bridge (mirrors adapter-registry.test.mjs's own scan-report schema check): both
// shipped providers' real plan() output, produced against a REAL fixture repo via the actual CLI
// (not a hand-built scanReport), must validate against schemas/handles-plan.schema.json.
test('java-spring provider.plan() output validates against schemas/handles-plan.schema.json', () => {
	const root = buildJavaSpringFixture();
	const scanResult = run(['scan', '--terms', 'widget', '--json'], root);
	assert.equal(scanResult.code, 0, scanResult.stderr);
	const scanReport = JSON.parse(scanResult.stdout);
	assert.equal(scanReport.adapter, 'java-spring');

	const provider = providerById(PROVIDERS, 'java-spring');
	const plan = provider.plan({ repoRoot: root, scanReport, module: null, resourceFilter: null });

	const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'handles-plan.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	assert.ok(validate(plan), `java-spring plan does not validate: ${JSON.stringify(validate.errors)}`);
	assert.equal(plan.resources.find((r) => r.type === 'Widget')?.willGenerateResolver, true);
});

test('python-fastapi provider.plan() output validates against schemas/handles-plan.schema.json', () => {
	const root = buildPythonFastApiFixture();
	const scanResult = run(['scan', '--terms', 'item', '--json'], root);
	assert.equal(scanResult.code, 0, scanResult.stderr);
	const scanReport = JSON.parse(scanResult.stdout);
	assert.equal(scanReport.adapter, 'python-fastapi');

	const provider = providerById(PROVIDERS, 'python-fastapi');
	const plan = provider.plan({ repoRoot: root, scanReport, module: null, resourceFilter: null });

	const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'handles-plan.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	assert.ok(validate(plan), `python-fastapi plan does not validate: ${JSON.stringify(validate.errors)}`);
	assert.equal(plan.resources.find((r) => r.type === 'Item')?.willGenerateResolver, true);
});
