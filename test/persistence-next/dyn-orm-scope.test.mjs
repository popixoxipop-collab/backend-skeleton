// Checks the four ORM scope records adapters/persistence/<orm>/SCOPE.json (contract bskel.internal.persistence-orm-scope-dyn/0).
// Every hash, count, pin and provider result is recomputed from the committed files and the repository providers; nothing is skipped:
// a missing file, a missing tool or a stale value fails the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTRACT, ORMS, PERSISTENCE_DIR, deriveCase, ripgrepAvailable, sha256, verifyScope } from '../../adapters/persistence/lib/dyn-orm-scope.mjs';

const orms = Object.keys(ORMS);
const dirOf = (orm) => path.join(PERSISTENCE_DIR, orm);
const load = (orm) => JSON.parse(fs.readFileSync(path.join(dirOf(orm), 'SCOPE.json'), 'utf8'));
const normalOf = (rec) => rec.cases.find((c) => c.kind === 'normal');
const EXACT = /^\d+\.\d+\.\d+$/;
const ZERO = '0'.repeat(64);

test('the four targets are present and ripgrep is installed (the python-fastapi adapter detects nothing without it)', () => {
	assert.deepEqual(orms, ['sqlalchemy-sqlmodel', 'django-orm', 'activerecord', 'eloquent']);
	assert.ok(ripgrepAvailable(), 'rg is required: without it the SQLAlchemy/SQLModel comparison would silently see no entities');
	for (const orm of orms) assert.ok(fs.statSync(path.join(dirOf(orm), 'SCOPE.json')).size > 0, `${orm}: SCOPE.json is missing or empty`);
});

for (const orm of orms) {
	test(`${orm}: the record re-derives from its files and the repository providers`, () => {
		assert.deepEqual(verifyScope(load(orm), dirOf(orm)), []);
	});

	test(`${orm}: hashes, pins, executed commands and counts recomputed independently of the checker`, () => {
		const rec = load(orm);
		assert.equal(rec.contract, CONTRACT);
		assert.equal(rec.target_id, `ORM-${orm}-01`);
		assert.deepEqual([rec.status.support_completed, rec.status.runtime_tested], [false, false], 'a scope record never claims completed support or a runtime test');
		assert.match(rec.pins.checked_at, /^\d{4}-\d{2}-\d{2}/);
		assert.ok(rec.pins.packages.some((p) => p.role === 'orm') && rec.pins.not_covered.length >= 1, 'pins name the ORM and at least one release that is not covered');
		assert.match(rec.oracle.environment.runtime.version, EXACT, 'the runtime that ran the oracle is an exact version');
		for (const p of [...rec.pins.packages, ...rec.pins.not_covered]) {
			assert.match(p.version, EXACT, `${p.name}: not an exact version`);
			assert.equal(p.registry_check.exit_code, 0);
			assert.equal(p.registry_check.output, p.version);
			assert.equal(sha256(p.registry_check.output), p.registry_check.output_sha256, `${p.name}: registry hash`);
		}
		assert.deepEqual(rec.profile.versions, rec.pins.packages.map((p) => `${p.name}@${p.version}`).sort());
		assert.deepEqual(rec.profile.capabilities, rec.constructs.filter((k) => k.support === 'supported').map((k) => k.id).sort());
		assert.ok(rec.constructs.some((k) => k.support !== 'supported'), 'unsupported constructs are listed next to the supported ones');
		const files = rec.cases.flatMap((c) => c.fixture.files);
		assert.ok(files.length > rec.cases.length, 'every case has a fixture and the drift case has two');
		for (const f of files) assert.equal(sha256(fs.readFileSync(path.join(dirOf(orm), f.path))), f.sha256, `${f.path}: fixture hash`);
		assert.ok(rec.oracle.setup.length >= 1 && rec.oracle.steps.length >= rec.cases.length, 'setup and oracle commands were recorded for every case');
		for (const s of [...rec.oracle.setup, ...rec.oracle.steps]) {
			const buf = fs.readFileSync(path.join(dirOf(orm), s.result_file));
			assert.equal(sha256(buf), s.output_sha256, `${s.id}: output hash`);
			assert.equal(buf.length, s.output_bytes, `${s.id}: output bytes`);
			assert.equal(s.exit_code, s.expect_exit, `${s.id}: exit code`);
			assert.ok(s.argv.length > 0);
			if (s.role === 'expected-schema') assert.ok(s.runs >= 2 && s.deterministic === true, `${s.id}: not identical over two runs`);
		}
		assert.equal(rec.probes.migration_plane.status, 'not-run');
		assert.equal(rec.probes.live_database.status, 'blocked');
		assert.ok(rec.probes.live_database.requires.length > 0 && rec.oracle.blocked.length >= 1, 'what cannot be run is an explicit blocked record with its reason');
	});

	test(`${orm}: normal fixture, tenant-scope and naming-strategy counterexamples, composite key, relation and drift are all present`, () => {
		const rec = load(orm);
		assert.ok(normalOf(rec), 'normal fixture');
		for (const category of ['baseline', 'composite-key', 'naming-strategy', 'relation', 'tenant-scope', 'migration-drift']) assert.ok(rec.cases.some((c) => c.category === category), `${category} case`);
		for (const category of ['tenant-scope', 'naming-strategy', 'composite-key', 'migration-drift']) assert.ok(rec.cases.some((c) => c.category === category && c.kind === 'counterexample'), `${category} counterexample`);
		const drift = rec.cases.find((c) => c.category === 'migration-drift');
		assert.deepEqual(Object.keys(drift.provider.changes).sort(), ['call_expected_v1_observed_v2', 'call_expected_v2_observed_v1', 'changes'], 'drift is compared in both directions');
		assert.ok(drift.fixture.files.some((f) => f.group === 'v1') && drift.fixture.files.some((f) => f.group === 'v2'));
	});

	test(`${orm}: the provider result is deterministic and equals the recorded one`, () => {
		const rec = load(orm);
		for (const c of rec.cases) {
			const first = deriveCase(orm, dirOf(orm), c), second = deriveCase(orm, dirOf(orm), c);
			assert.deepEqual(first, second, `${c.id}: two runs differ`);
			assert.deepEqual([first.provider, first.agreement, first.expected_changes, first.outcome], [c.provider, c.agreement, c.expected_changes, c.outcome], `${c.id}: differs from the record`);
		}
	});
}

// Each tamper must be caught by the check that is meant to catch it (the pattern names that check), never by luck.
const tampers = [
	['fixture hash', (r) => { r.cases[0].fixture.files[0].sha256 = ZERO; }, /sha256 differs/],
	['oracle output hash', (r) => { r.oracle.steps[0].output_sha256 = 'f'.repeat(64); }, /result file sha256 or size differs/],
	['oracle output size', (r) => { r.oracle.steps[0].output_bytes += 1; }, /result file sha256 or size differs/],
	['oracle exit code', (r) => { r.oracle.steps[0].exit_code = 1; }, /exit code 1 is not the expected/],
	['single oracle run', (r) => { r.oracle.steps[0].runs = 1; }, /not recorded as identical over two runs/],
	['expected facts', (r) => { const c = normalOf(r); c.expected[c.oracle_steps[0]].tables.push('ghost_table'); }, /differs from the recorded oracle output/],
	['provider facts', (r) => { normalOf(r).provider.facts.tables.push('ghost_table'); }, /provider differs from a fresh run/],
	['outcome flip', (r) => { const c = normalOf(r); c.outcome = c.outcome === 'agrees' ? 'omits' : 'agrees'; }, /outcome differs from a fresh run/],
	['pin version', (r) => { r.pins.packages[0].version = '0.0.1'; }, /registry check does not support it/],
	['registry output hash', (r) => { r.pins.packages[0].registry_check.output_sha256 = ZERO; }, /registry check does not support it/],
	['registry exit code', (r) => { r.pins.packages[0].registry_check.exit_code = 1; }, /registry check does not support it/],
	['pin dropped from the profile', (r) => { r.profile.versions.pop(); }, /profile\.versions differs from the pins/],
	['unsupported promoted to supported', (r) => { Object.assign(r.constructs.find((k) => k.support === 'unsupported'), { support: 'supported', implementation: 'implemented', gap_behavior: 'none' }); }, /construct .*: supported/],
	['support_completed', (r) => { r.status.support_completed = true; }, /does not match the schema/],
	['runtime_tested', (r) => { r.status.runtime_tested = true; }, /does not match the schema/],
	['catalog block', (r) => { r.catalog = { ...r.catalog, id: 'other' }; }, /catalog block differs/],
	['drift fixture entry dropped', (r) => { r.cases.find((c) => c.category === 'migration-drift').fixture.files.pop(); }, /files under fixtures\/ differ/],
	['tenant-scope case removed', (r) => { r.cases = r.cases.filter((c) => c.category !== 'tenant-scope'); }, /no tenant-scope case/],
	['case without oracle step and without blocked record', (r) => { const c = r.cases.find((x) => x.category === 'relation'); c.oracle_steps = []; c.expected = null; }, /no oracle step and no blocked record/],
];
for (const orm of orms) {
	test(`${orm}: tampering with the record is caught`, () => {
		for (const [name, mutate, pattern] of tampers) {
			const rec = structuredClone(load(orm));
			mutate(rec);
			const errors = verifyScope(rec, dirOf(orm));
			assert.ok(errors.some((e) => pattern.test(e)), `${name}: expected ${pattern}, got ${JSON.stringify(errors.slice(0, 3))}`);
		}
	});
}

test('tampering with the files on disk is caught (and the untouched copy passes)', () => {
	const orm = 'django-orm', rec = load(orm);
	const fixture = rec.cases[0].fixture.files[0].path, result = rec.oracle.steps[0].result_file;
	const cases = [
		['unchanged copy', () => {}, null],
		['fixture byte changed', (d) => fs.appendFileSync(path.join(d, fixture), '\n# changed\n'), /sha256 differs/],
		['unlisted fixture file added', (d) => fs.writeFileSync(path.join(d, 'fixtures', 'stray.py'), 'x = 1\n'), /files under fixtures\/ differ/],
		['oracle result changed', (d) => fs.appendFileSync(path.join(d, result), ' '), /result file sha256 or size differs/],
		['oracle result deleted', (d) => fs.rmSync(path.join(d, result)), /result file is missing/],
	];
	for (const [name, mutate, pattern] of cases) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orm-tamper-'));
		try {
			const copy = path.join(root, orm);
			fs.cpSync(dirOf(orm), copy, { recursive: true });
			mutate(copy);
			const errors = verifyScope(rec, copy);
			if (pattern) assert.ok(errors.some((e) => pattern.test(e)), `${name}: expected ${pattern}, got ${JSON.stringify(errors.slice(0, 3))}`);
			else assert.deepEqual(errors, [], name);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	}
});
