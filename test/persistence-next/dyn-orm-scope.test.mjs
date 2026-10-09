// Checks the four ORM scope records adapters/persistence/<orm>/SCOPE.json (contract bskel.internal.persistence-orm-scope-dyn/0).
// Every hash, count, pin and provider result is recomputed from the committed files and the repository providers; nothing is skipped:
// a missing file, a missing tool or a stale value fails the test. Oracle results are frozen files bound by digest to the fixtures and
// script that produced them; the tests below edit those inputs without regenerating the results and require the edit to be rejected.
// Re-running the oracle needs the pinned toolchain: set ORM_SCOPE_ORACLE_<ORM> (e.g. ORM_SCOPE_ORACLE_DJANGO_ORM) to the directory the
// setup steps installed into. Without it those steps are reported unverified in the test output and never counted as reproduced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTRACT, ORMS, PERSISTENCE_DIR, deriveCase, oracleEnvName, reexecute, reexecuteStep, reproducedAgreement, ripgrepAvailable, sha256, toolchainFromEnv, verifyScope } from '../../adapters/persistence/lib/dyn-orm-scope.mjs';

const orms = Object.keys(ORMS);
const dirOf = (orm) => path.join(PERSISTENCE_DIR, orm);
const load = (orm) => JSON.parse(fs.readFileSync(path.join(dirOf(orm), 'SCOPE.json'), 'utf8'));
const normalOf = (rec) => rec.cases.find((c) => c.kind === 'normal');
const EXACT = /^\d+\.\d+\.\d+$/;
const ZERO = '0'.repeat(64);
const SCRIPT = { 'sqlalchemy-sqlmodel': 'oracle/introspect.py', 'django-orm': 'oracle/introspect.py', activerecord: 'oracle/introspect.rb', eloquent: 'oracle/introspect.php' };
const STALE = /frozen oracle output was produced from different input files/;
// What a stale frozen output is reported as: the step itself, and each case that depends on it (its agreement is then not counted).
const BINDING = /frozen oracle output was produced from different input files|is missing or not bound to the current inputs/;

function withCopy(orm, fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orm-copy-'));
	try {
		const copy = path.join(root, orm);
		fs.cpSync(dirOf(orm), copy, { recursive: true });
		return fn(copy);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}
// Replaces the recorded sha256 of one file wherever the record names it: the case fixture entries and every step's inputs.
function refresh(rec, rel, hash) {
	const walk = (node) => {
		if (Array.isArray(node)) node.forEach(walk);
		else if (node && typeof node === 'object') {
			if (node.path === rel && typeof node.sha256 === 'string') node.sha256 = hash;
			Object.values(node).forEach(walk);
		}
	};
	walk(rec);
}

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
		const disk = (rel) => sha256(fs.readFileSync(path.join(dirOf(orm), rel)));
		for (const s of rec.oracle.steps) {
			const owner = rec.cases.find((c) => c.id === s.case);
			const target = s.argv.find((a) => a.startsWith('fixtures/'));
			const consumed = owner.fixture.files.filter((f) => f.path === target || f.path.startsWith(`${target}/`));
			const want = Object.fromEntries([SCRIPT[orm], ...consumed.map((f) => f.path)].map((rel) => [rel, disk(rel)]));
			const frozen = JSON.parse(fs.readFileSync(path.join(dirOf(orm), s.result_file), 'utf8'));
			assert.ok(consumed.length >= 1, `${s.id}: the command names no fixture file of its case`);
			assert.deepEqual(frozen.inputs, want, `${s.id}: the digests the oracle printed are not those of the files on disk`);
			assert.deepEqual(Object.fromEntries(s.inputs.map((i) => [i.path, i.sha256])), want, `${s.id}: recorded inputs`);
			assert.deepEqual(s.tool_versions, frozen.versions, `${s.id}: recorded tool versions`);
		}
		for (const c of rec.cases) {
			const used = rec.oracle.steps.filter((s) => s.case === c.id).flatMap((s) => Object.keys(JSON.parse(fs.readFileSync(path.join(dirOf(orm), s.result_file), 'utf8')).inputs)).filter((p) => p.startsWith('fixtures/'));
			assert.deepEqual(used.sort(), c.fixture.files.map((f) => f.path).sort(), `${c.id}: the fixture files listed are exactly the files the oracle consumed (support files included)`);
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
			assert.deepEqual(first.inputs, c.fixture.files.map(({ path: p, role, sha256: h }) => ({ path: p, role, sha256: h })), `${c.id}: the provider side must read every listed file, whatever its role`);
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
	['recorded step input digest', (r) => { r.oracle.steps[0].inputs[0].sha256 = ZERO; }, /recorded inputs differ from the files the command consumes/],
	['recorded step inputs removed', (r) => { delete r.oracle.steps[0].inputs; }, /recorded inputs differ from the files the command consumes/],
	['recorded tool version', (r) => { const v = r.oracle.steps[0].tool_versions; v[Object.keys(v)[0]] = '0.0.1'; }, /recorded tool_versions differ/],
	['argv replaced by another command', (r) => { r.oracle.steps[0].argv = ['sh', '-c', 'true']; }, /argv is not the committed oracle command/],
	['oracle step claimed by another case', (r) => { r.cases[1].oracle_steps = [...r.cases[0].oracle_steps]; }, /belongs to case/],
	['oracle step nobody uses', (r) => { r.oracle.steps.push({ ...r.oracle.steps[0], id: 'orphan' }); }, /orphan: no case uses this oracle step/],
	['drift fixture entry dropped (the oracle still consumed it)', (r) => { r.cases.find((c) => c.category === 'migration-drift').fixture.files.pop(); }, /files its oracle steps consumed are not the fixture files the case lists/],
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

// An oracle result is a frozen file. Editing what it was produced from, without regenerating it, must fail even when the editor refreshes
// every hash the record keeps (case fixture entries and each step's recorded inputs): only the digests the oracle itself printed remain.
for (const orm of orms) {
	test(`${orm}: a fixture, support file or oracle script edited without re-running the oracle is rejected although every recorded hash is refreshed`, () => {
		const rec = load(orm);
		const files = rec.cases.flatMap((c) => c.fixture.files);
		const append = (b) => Buffer.concat([b, Buffer.from('\n# edited after the oracle ran\n')]);
		const edits = [
			['model file edited', files.find((f) => f.role === 'model').path, append, true],
			['model file emptied', files.find((f) => f.role === 'model').path, () => Buffer.alloc(0), false],
			['oracle script edited', SCRIPT[orm], append, true],
		];
		const support = files.find((f) => f.role === 'support');
		if (support) edits.push(['support file edited', support.path, append, true]);
		for (const [name, rel, change, bindingOnly] of edits) {
			withCopy(orm, (copy) => {
				const file = path.join(copy, rel);
				fs.writeFileSync(file, change(fs.readFileSync(file)));
				const edited = structuredClone(rec);
				refresh(edited, rel, sha256(fs.readFileSync(file)));
				const errors = verifyScope(edited, copy);
				const stale = errors.filter((e) => STALE.test(e));
				assert.ok(stale.length >= 1, `${name}: expected a stale-oracle error, got ${JSON.stringify(errors.slice(0, 4))}`);
				if (bindingOnly) assert.deepEqual(errors.filter((e) => !BINDING.test(e)), [], `${name}: every other hash was refreshed, so only the input binding may object`);
			});
		}
		assert.ok(orm === 'sqlalchemy-sqlmodel' || orm === 'django-orm' || support, `${orm}: a support file must exist to be edited`);
	});

	test(`${orm}: a hand-forged oracle result with every hash refreshed is unverified without the toolchain (never reproduced) and rejected with it`, () => {
		const rec = load(orm);
		withCopy(orm, (copy) => {
			const forged = structuredClone(rec);
			const step = forged.oracle.steps[0];
			const file = path.join(copy, step.result_file);
			// Adds one fact to the unmodeled list, leaving every other byte of the frozen output as the oracle wrote it.
			const text = fs.readFileSync(file, 'utf8').replace(/("unmodeled":\s*)\[/, '$1["forged-fact", ').replace('["forged-fact", ]', '["forged-fact"]');
			fs.writeFileSync(file, text);
			step.output_sha256 = sha256(text);
			step.output_bytes = Buffer.byteLength(text);
			const owner = forged.cases.find((c) => c.id === step.case);
			owner.expected[step.id] = JSON.parse(text).facts;
			assert.ok(owner.expected[step.id].unmodeled.includes('forged-fact'));
			const toolchain = toolchainFromEnv(orm);
			const results = reexecute(forged, copy, toolchain);
			const status = results.find((r) => r.id === step.id);
			assert.ok(!reproducedAgreement(forged, results).includes(owner.id), 'a forged step must never count as reproduced agreement');
			if (toolchain.missing) {
				assert.deepEqual(verifyScope(forged, copy), [], 'the digest checks alone cannot tell a hand-edited result from a regenerated one: that is the limit this test records');
				assert.equal(status.status, 'unverified');
				assert.match(status.reason, new RegExp(oracleEnvName(orm)));
			} else {
				assert.equal(status.status, 'differs', status.reason);
				assert.ok(verifyScope(forged, copy, { reexecute: true }).some((e) => /does not reproduce the frozen output/.test(e)));
			}
		});
	});

	test(`${orm}: oracle steps are re-run where the pinned toolchain exists and reported unverified, with the reason, where it does not`, (t) => {
		const rec = load(orm), toolchain = toolchainFromEnv(orm);
		const results = reexecute(rec, dirOf(orm), toolchain);
		const count = (status) => results.filter((r) => r.status === status).length;
		t.diagnostic(`${orm}: ${count('reproduced')} reproduced, ${count('differs')} differs, ${count('unverified')} unverified${toolchain.missing ? ` (${toolchain.missing})` : ''}`);
		assert.equal(results.length, rec.oracle.setup.length + rec.oracle.steps.length);
		assert.equal(count('differs'), 0, JSON.stringify(results.filter((r) => r.status === 'differs')));
		for (const r of results) assert.ok(r.reason.length > 0, `${r.id}: a status always carries its reason`);
		assert.ok(results.filter((r) => r.role === 'setup').every((r) => r.status === 'unverified'), 'install transcripts are never re-run');
		const steps = results.filter((r) => r.role === 'expected-schema');
		if (toolchain.missing) {
			assert.ok(steps.every((r) => r.status === 'unverified' && r.reason.includes(oracleEnvName(orm))), 'without the toolchain every oracle step is unverified and says what to set');
			assert.deepEqual(reproducedAgreement(rec, results), [], 'unverified steps never count as agreement');
		} else {
			assert.ok(steps.every((r) => r.status === 'reproduced'), JSON.stringify(steps.filter((r) => r.status !== 'reproduced')));
			assert.deepEqual(reproducedAgreement(rec, results), rec.cases.filter((c) => c.agreement).map((c) => c.id));
			assert.deepEqual(verifyScope(rec, dirOf(orm), { reexecute: true }), []);
		}
	});
}

test('reexecuteStep: reproduced when the rerun equals the frozen file, differs when it does not, unverified when it cannot run', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orm-reexec-'));
	try {
		fs.writeFileSync(path.join(root, 'frozen.out'), 'frozen');
		fs.writeFileSync(path.join(root, 'placeholder.out'), `${root}/x`);
		const step = (argv, extra = {}) => ({ id: 'synthetic', role: 'expected-schema', argv, expect_exit: 0, result_file: 'frozen.out', ...extra });
		const say = (text) => [process.execPath, '-e', `process.stdout.write(${JSON.stringify(text)})`];
		const toolchain = { root, bin: '' };
		assert.equal(reexecuteStep(step(say('frozen')), root, toolchain).status, 'reproduced');
		assert.equal(reexecuteStep(step(say('other')), root, toolchain).status, 'differs');
		assert.equal(reexecuteStep(step([process.execPath, '-e', 'process.exit(3)']), root, toolchain).status, 'differs', 'a different exit code is a difference');
		assert.equal(reexecuteStep(step([process.execPath, '-e', 'process.stdout.write(process.argv[1])', '$ORACLE_VENV/x'], { result_file: 'placeholder.out' }), root, toolchain).status, 'reproduced', '$ORACLE_VENV is the toolchain root');
		for (const [name, result] of [
			['no toolchain given', reexecuteStep(step(say('frozen')), root, { missing: 'set ORM_SCOPE_ORACLE_X' })],
			['toolchain directory absent', reexecuteStep(step(say('frozen')), root, { root: path.join(root, 'absent'), bin: '' })],
			['program not found', reexecuteStep(step(['definitely-not-a-program-xyz']), root, toolchain)],
			['frozen file missing', reexecuteStep(step(say('frozen'), { result_file: 'absent.out' }), root, toolchain)],
			['install transcript', reexecuteStep(step(say('frozen'), { role: 'setup' }), root, toolchain)],
		]) {
			assert.equal(result.status, 'unverified', name);
			assert.ok(result.reason.length > 0, `${name}: reason`);
		}
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reexecute runs only the committed oracle command, never another argv a record asks for', () => {
	const orm = 'django-orm', marker = path.join(os.tmpdir(), `orm-scope-marker-${process.pid}`);
	const rec = structuredClone(load(orm));
	rec.oracle.setup = [];
	rec.oracle.steps = [{ ...rec.oracle.steps[0], argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] }];
	try {
		const [result] = reexecute(rec, dirOf(orm), { root: os.tmpdir(), bin: '' });
		assert.equal(result.status, 'unverified');
		assert.match(result.reason, /not the committed oracle command/);
		assert.ok(!fs.existsSync(marker), 'the recorded argv was executed');
	} finally { fs.rmSync(marker, { force: true }); }
});

test('deriveCase reads every file a case lists, whatever its role: a changed support file changes its inputs, a missing one fails the derivation', () => {
	let exercised = 0;
	for (const orm of orms) {
		const rec = load(orm);
		const c = rec.cases.find((x) => x.fixture.files.some((f) => f.role === 'support'));
		if (!c) continue;
		exercised += 1;
		withCopy(orm, (copy) => {
			const support = c.fixture.files.find((f) => f.role === 'support');
			const before = deriveCase(orm, copy, c);
			assert.deepEqual(before.inputs, c.fixture.files.map(({ path: p, role, sha256: h }) => ({ path: p, role, sha256: h })), `${orm}: inputs of the untouched copy`);
			const file = path.join(copy, support.path);
			fs.appendFileSync(file, '\n# changed after the oracle ran\n');
			const after = deriveCase(orm, copy, c);
			const entry = after.inputs.find((i) => i.path === support.path);
			assert.equal(entry.sha256, sha256(fs.readFileSync(file)), `${orm}: the digest is that of the bytes read now`);
			assert.notEqual(entry.sha256, support.sha256);
			assert.deepEqual({ ...after, inputs: null }, { ...before, inputs: null }, `${orm}: the providers do not parse support files, so only the inputs move`);
			fs.rmSync(file);
			assert.throws(() => deriveCase(orm, copy, c), { code: 'ENOENT' }, `${orm}: a missing support file must fail the derivation`);
		});
	}
	assert.ok(exercised >= 2, 'the ActiveRecord and Eloquent fixtures carry support files; nothing was exercised otherwise');
});
