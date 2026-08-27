// G1: unit tests for scanners/registry.mjs (zero-registration adapter discovery) and the
// arbitration/ambiguity logic in scanners/index.mjs::runScan(). No repo mutation -- every fixture
// adapter lives in a fresh mkdtemp'd directory, loaded via loadAdapters({adaptersDir}).
// See D-adapter-registry in DECISIONS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadAdapters, adapterById, ADAPTERS, LOAD_ERRORS } from '../scanners/registry.mjs';
import { runScan } from '../scanners/index.mjs';
import { CAPABILITY_NAMES, COMMAND_CAPABILITIES } from '../scanners/capabilities.mjs';

const REPO_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

function tmpAdaptersDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-adapter-registry-'));
}

function writeAdapter(dir, filename, source) {
	fs.writeFileSync(path.join(dir, filename), source);
}

// A minimal, always-valid adapter body -- individual tests override just the fields under test.
function fixtureSource({ id = 'zzz-fixture', contract = "'sbf.adapter/2'", specificity = 50, capabilities = "{ 'api.operations': true }", verificationBasis = "'synthetic-only'", detectReturns = 'true' } = {}) {
	return `
export const adapter = {
  contract: ${contract},
  id: '${id}',
  title: 'Fixture adapter',
  specificity: ${specificity},
  confidence: 'high',
  capabilities: ${capabilities},
  verificationBasis: ${verificationBasis},
  detect(repoRoot) { return ${detectReturns}; },
  scan(repoRoot, detection) { return { modules: [] }; },
};
`;
}

test('real registry: loads exactly java-spring, python-fastapi, typescript-express, javascript-express, and generic-grep, sorted by specificity descending', async () => {
	assert.deepEqual(LOAD_ERRORS, []);
	assert.deepEqual(ADAPTERS.map((a) => a.id), ['java-spring', 'python-fastapi', 'typescript-express', 'javascript-express', 'generic-grep']);
	assert.equal(ADAPTERS[0].specificity, 100);
	assert.equal(ADAPTERS[1].specificity, 90);
	assert.equal(ADAPTERS[2].specificity, 85);
	assert.equal(ADAPTERS[3].specificity, 80);
	assert.equal(ADAPTERS[4].specificity, 0);
});

test('real registry: every CAPABILITY_NAMES key is declared (true or false) by every shipped adapter', () => {
	for (const a of ADAPTERS) {
		for (const cap of CAPABILITY_NAMES) {
			assert.equal(typeof a.capabilities[cap], 'boolean', `${a.id}.capabilities['${cap}'] must be a boolean`);
		}
	}
});

test('zero-registration: a well-formed adapter file dropped into a directory is discovered with no other edit', async () => {
	const dir = tmpAdaptersDir();
	writeAdapter(dir, 'zzz-fixture.mjs', fixtureSource());
	const { adapters, errors } = await loadAdapters({ adaptersDir: dir });
	assert.deepEqual(errors, []);
	assert.equal(adapters.length, 1);
	assert.equal(adapters[0].id, 'zzz-fixture');
});

test('arbitration: a higher-specificity adapter wins over a lower one when both detect', async () => {
	const dir = tmpAdaptersDir();
	writeAdapter(dir, 'aaa-high.mjs', fixtureSource({ id: 'aaa-high', specificity: 999 }));
	writeAdapter(dir, 'bbb-low.mjs', fixtureSource({ id: 'bbb-low', specificity: 1 }));
	const { adapters } = await loadAdapters({ adaptersDir: dir });
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters });
	assert.equal(report.adapter, 'aaa-high');
});

test('arbitration: when only the lower-specificity adapter detects, it wins', async () => {
	const dir = tmpAdaptersDir();
	writeAdapter(dir, 'aaa-high.mjs', fixtureSource({ id: 'aaa-high', specificity: 999, detectReturns: 'null' }));
	writeAdapter(dir, 'bbb-low.mjs', fixtureSource({ id: 'bbb-low', specificity: 1 }));
	const { adapters } = await loadAdapters({ adaptersDir: dir });
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters });
	assert.equal(report.adapter, 'bbb-low');
});

test('runScan throws naming every tried adapter when none detects', async () => {
	const dir = tmpAdaptersDir();
	writeAdapter(dir, 'aaa.mjs', fixtureSource({ id: 'aaa', detectReturns: 'null' }));
	writeAdapter(dir, 'bbb.mjs', fixtureSource({ id: 'bbb', detectReturns: 'null' }));
	const { adapters } = await loadAdapters({ adaptersDir: dir });
	assert.throws(() => runScan({ repoRoot: '/does/not/matter', terms: [], adapters }), /aaa.*bbb|bbb.*aaa/s);
});

test('runScan throws a named, loud error when two adapters at the SAME specificity both detect', async () => {
	const dir = tmpAdaptersDir();
	writeAdapter(dir, 'aaa-tied.mjs', fixtureSource({ id: 'aaa-tied', specificity: 50 }));
	writeAdapter(dir, 'bbb-tied.mjs', fixtureSource({ id: 'bbb-tied', specificity: 50 }));
	const { adapters } = await loadAdapters({ adaptersDir: dir });
	assert.throws(
		() => runScan({ repoRoot: '/does/not/matter', terms: [], adapters }),
		/ambiguous adapter selection.*aaa-tied.*bbb-tied/s,
	);
});

test('malformed adapters: each failure mode is collected in LOAD_ERRORS naming its file, and valid siblings still load', async () => {
	const dir = tmpAdaptersDir();
	writeAdapter(dir, 'good.mjs', fixtureSource({ id: 'good' }));
	writeAdapter(dir, 'no-export.mjs', 'export const somethingElse = {};\n');
	writeAdapter(dir, 'id-mismatch.mjs', fixtureSource({ id: 'wrong-name' }));
	writeAdapter(dir, 'bad-version.mjs', fixtureSource({ id: 'bad-version', contract: "'sbf.adapter/99'" }));
	writeAdapter(dir, 'bad-capability.mjs', fixtureSource({ id: 'bad-capability', capabilities: "{ 'api.operation': true }" }));
	writeAdapter(dir, 'syntax-error.mjs', 'export const adapter = {\n');

	const { adapters, errors } = await loadAdapters({ adaptersDir: dir });

	assert.equal(adapters.length, 1);
	assert.equal(adapters[0].id, 'good');
	assert.equal(errors.length, 5);
	const byFile = Object.fromEntries(errors.map((e) => [path.basename(e.file), e.message]));
	assert.match(byFile['no-export.mjs'], /export const adapter/);
	assert.match(byFile['id-mismatch.mjs'], /must equal its filename/);
	assert.match(byFile['bad-version.mjs'], /sbf\.adapter\/99/);
	assert.match(byFile['bad-capability.mjs'], /does not match schemas\/adapter\.schema\.json/);
	assert.match(byFile['syntax-error.mjs'], /failed to load/);
});

test('files prefixed with _ or . are skipped, not treated as malformed adapters', async () => {
	const dir = tmpAdaptersDir();
	writeAdapter(dir, 'good.mjs', fixtureSource({ id: 'good' }));
	writeAdapter(dir, '_shared-helper.mjs', 'this is not even valid JS on its own {{{');
	writeAdapter(dir, '.hidden.mjs', 'also not valid JS {{{');
	const { adapters, errors } = await loadAdapters({ adaptersDir: dir });
	assert.deepEqual(errors, []);
	assert.equal(adapters.length, 1);
	assert.equal(adapters[0].id, 'good');
});

test('adapterById finds a loaded adapter by id, and returns null for an unknown one', () => {
	assert.equal(adapterById(ADAPTERS, 'java-spring').id, 'java-spring');
	assert.equal(adapterById(ADAPTERS, 'does-not-exist'), null);
});

// S1-style drift guard: every capability COMMAND_CAPABILITIES references must be a real,
// declared capability -- a typo here would silently mean "no command ever requires it".
test('every capability referenced in COMMAND_CAPABILITIES is a real CAPABILITY_NAMES entry', () => {
	for (const [command, caps] of Object.entries(COMMAND_CAPABILITIES)) {
		for (const cap of caps) {
			assert.ok(CAPABILITY_NAMES.includes(cap), `COMMAND_CAPABILITIES['${command}'] references unknown capability '${cap}'`);
		}
	}
});

// The schema's capabilities.propertyNames.enum must list exactly CAPABILITY_NAMES -- otherwise a
// real capability would be silently rejected as "unknown" (or a stale one silently accepted).
test('schemas/adapter.schema.json\'s capabilities enum matches CAPABILITY_NAMES exactly', () => {
	const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'adapter.schema.json'), 'utf8'));
	const schemaCaps = schema.properties.capabilities.propertyNames.enum;
	assert.deepEqual([...schemaCaps].sort(), [...CAPABILITY_NAMES].sort());
});

// Schema-accuracy bridge (G1's other fix): a real runScan() output must validate against the
// (now-corrected) scan-report schema. Zero runtime cost -- proves the schema describes reality,
// which it did NOT before this item (additionalProperties:false with no path_prefix_signals
// property meant every real report ever produced failed its own schema).
test('a real runScan() output validates against schemas/scan-report.schema.json', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-scan-report-schema-check-'));
	const report = runScan({ repoRoot: tmp, terms: ['whatever'] });

	const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'scan-report.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	const ok = validate(report);
	assert.ok(ok, `real scan report does not validate: ${JSON.stringify(validate.errors)}`);
});
