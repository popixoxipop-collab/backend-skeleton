// P4 (D-extension-conformance): dog-foods scanners/conformance.mjs and handles/conformance.mjs
// against every real adapter and provider this project ships. Not assumed to pass in advance --
// grounding this live against the real java-spring provider found a genuine, pre-existing design
// wrinkle (provider.outputs.spec entries, e.g. handles/migration.sql, are intentionally
// regenerated on every emit() call) that the harness itself had to account for (see the
// provider.outputs.spec exemption in handles/conformance.mjs) before this file could go green
// honestly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../scanners/registry.mjs';
import { checkAdapterConformance } from '../scanners/conformance.mjs';
import { runScan } from '../scanners/index.mjs';
import { PROVIDERS, providerById } from '../handles/registry.mjs';
import { checkProviderConformance } from '../handles/conformance.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JAVA_FIXTURE = path.join(__dirname, 'fixtures', 'java-spring');
const PYTHON_FIXTURE = path.join(__dirname, 'fixtures', 'python-fastapi');

function scratchCopyOf(fixtureDir) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-conformance-'));
	fs.cpSync(fixtureDir, root, { recursive: true });
	return root;
}

// Every shipped adapter, checked against a fixture it actually detects. generic-grep (the
// fallback, specificity 0, detect() always true) is exercised against the java-spring fixture --
// it makes no framework-specific claim, so any real repo is a fair conformance target for it.
const ADAPTER_FIXTURES = {
	'java-spring': JAVA_FIXTURE,
	'python-fastapi': PYTHON_FIXTURE,
	'generic-grep': JAVA_FIXTURE,
};

test('checkAdapterConformance passes for every shipped scanner adapter', () => {
	assert.ok(ADAPTERS.length >= 3, 'sanity: expected java-spring, python-fastapi, generic-grep to be loaded');
	for (const adapter of ADAPTERS) {
		const repoRoot = ADAPTER_FIXTURES[adapter.id];
		assert.ok(repoRoot, `no fixture wired for adapter "${adapter.id}" -- add one to ADAPTER_FIXTURES`);
		const result = checkAdapterConformance(adapter, repoRoot);
		assert.deepEqual(result.errors, [], `${adapter.id}: ${result.errors.join('; ')}`);
		assert.equal(result.ok, true, `${adapter.id} failed conformance`);
	}
});

test('checkProviderConformance passes for the real java-spring handles provider', () => {
	const root = scratchCopyOf(JAVA_FIXTURE);
	try {
		const scanReport = runScan({ repoRoot: root, terms: ['organization', 'curriculum', 'security'] });
		const provider = providerById(PROVIDERS, 'java-spring');
		assert.ok(provider, 'java-spring provider must be loaded');
		const result = checkProviderConformance(provider, { repoRoot: root, scanReport });
		assert.deepEqual(result.errors, [], result.errors.join('; '));
		assert.equal(result.ok, true);
		assert.ok(result.firstEmitWritten.length > 0, 'sanity: emit() must actually generate something against this fixture');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('checkProviderConformance passes for the real python-fastapi handles provider', () => {
	const root = scratchCopyOf(PYTHON_FIXTURE);
	try {
		const scanReport = runScan({ repoRoot: root, terms: ['item'] });
		const provider = providerById(PROVIDERS, 'python-fastapi');
		assert.ok(provider, 'python-fastapi provider must be loaded');
		const result = checkProviderConformance(provider, { repoRoot: root, scanReport });
		assert.deepEqual(result.errors, [], result.errors.join('; '));
		assert.equal(result.ok, true);
		assert.ok(result.firstEmitWritten.length > 0, 'sanity: emit() must actually generate something against this fixture');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// Proves the harness actually discriminates -- a fixed-point summary that all 5 real
// adapters/providers pass would be equally true of a harness that always returns ok:true.
test('checkAdapterConformance and checkProviderConformance both catch a genuinely broken implementation', () => {
	const flakyAdapter = {
		id: 'zz-conformance-flaky',
		detect: () => true,
		scan: (() => {
			let n = 0;
			return () => ({ modules: [{ module: 'm', controllers: [], entities: [], enums: [], nonce: n++ }] });
		})(),
	};
	const adapterResult = checkAdapterConformance(flakyAdapter, '/tmp');
	assert.equal(adapterResult.ok, false);
	assert.match(adapterResult.errors[0], /not deterministic/);

	const nonIdempotentProvider = {
		id: 'zz-conformance-non-idempotent',
		outputs: { spec: [] },
		plan: () => ({ schema: 'sbf.handles-plan/1', provider: 'zz-conformance-non-idempotent', module: null, resources: [], notes: [] }),
		emit: () => ({ written: ['always-rewritten.txt'], resolverStubs: [], conflicts: [], orphans: [], notes: [], forced: [], blocked: false }),
	};
	const providerResult = checkProviderConformance(nonIdempotentProvider, { repoRoot: '/tmp', scanReport: {}, featureId: 'zz' });
	assert.equal(providerResult.ok, false);
	assert.match(providerResult.errors[0], /not idempotent/);
});
