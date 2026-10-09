import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCanonicalFormat, auditScope, formatFinding, parsePinHeader, REQUIRED_PINS, validateScopeSchema } from '../../adapters/persistence/lib/js-orm-scope-audit.mjs';
import { applyEvidence, computeEvidence, diskIo, formatScope } from '../../adapters/persistence/lib/js-orm-scope-evidence.mjs';
import { ORMS, ripgrepAvailable } from '../../adapters/persistence/lib/js-orm-scope-providers.mjs';
import { isPersistenceTargetAdmitted } from '../../scanners/persistence-next/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../adapters/persistence');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const read = (orm, rel) => fs.readFileSync(path.join(ROOT, orm, rel), 'utf8');
const loadScope = (orm) => JSON.parse(read(orm, 'SCOPE.json'));
const skipProvider = ripgrepAvailable() ? false : 'ripgrep is required to recompute provider output';
const evidenceCache = new Map();
const evidenceOf = (orm) => {
	if (!evidenceCache.has(orm)) evidenceCache.set(orm, computeEvidence(orm, loadScope(orm)));
	return evidenceCache.get(orm);
};
const codesOf = (orm, scope, io = diskIo(orm)) => auditScope(orm, scope, { evidence: evidenceOf(orm), io }).map((item) => item.code);
const mutated = (orm, change) => {
	const scope = loadScope(orm);
	change(scope);
	return scope;
};
const claimSupported = (construct) => Object.assign(construct, { support: 'supported', implementation: 'implemented', gap_behavior: 'none', planned_in: null, facets: construct.facets.length ? construct.facets : ['tables'] });

test('the four records cover prisma, drizzle, typeorm and sequelize', () => {
	assert.deepEqual([...ORMS].sort(), ['drizzle', 'prisma', 'sequelize', 'typeorm']);
});

for (const orm of ORMS) {
	const raw = read(orm, 'SCOPE.json');
	const scope = JSON.parse(raw);
	const files = scope.cases.flatMap((item) => item.fixture.files);
	const pinned = new Map(scope.pins.packages.map((pkg) => [pkg.name, pkg.version]));

	test(`${orm}: record validates against the schema and is stored canonically`, () => {
		const result = validateScopeSchema(scope);
		assert.ok(result.ok, result.errors.join('; '));
		assert.equal(formatScope(scope), raw);
		assert.deepEqual(auditCanonicalFormat(orm), []);
	});

	test(`${orm}: fixture hashes are recomputed from the committed files`, () => {
		assert.ok(files.length > 0);
		for (const file of files) assert.equal(digest(read(orm, file.path).replace(/\r\n/g, '\n')), file.sha256, file.path);
	});

	test(`${orm}: oracle results match the recorded hash, byte count, exit code and two identical runs`, () => {
		assert.ok(scope.oracle.steps.length > 0);
		for (const step of scope.oracle.steps) {
			const content = read(orm, step.result_file);
			assert.equal(digest(content), step.output_sha256, step.id);
			assert.equal(Buffer.byteLength(content), step.output_bytes, step.id);
			assert.equal(step.exit_code, step.expect_exit, step.id);
			assert.ok(step.runs === 2 && step.deterministic === true, step.id);
		}
	});

	test(`${orm}: pinned versions appear in registry checks, fixture headers and metadata`, () => {
		for (const [name, version] of pinned) {
			const check = scope.pins.packages.find((pkg) => pkg.name === name).registry_check;
			assert.deepEqual([check.command, check.exit_code, check.output], [`npm view ${name}@${version} version`, 0, version]);
			assert.equal(check.output_sha256, digest(check.output));
			assert.equal(scope.oracle.environment.installed[name], version);
		}
		for (const item of scope.pins.not_covered) {
			assert.equal(item.registry_check.output, item.version);
			assert.notEqual(item.version, pinned.get(item.name));
		}
		const headers = files.flatMap((file) => parsePinHeader(read(orm, file.path)) ?? []);
		for (const name of REQUIRED_PINS[orm]) {
			assert.ok(pinned.get(name), `${name} is not pinned`);
			assert.ok(scope.profile.versions.includes(`${name}@${pinned.get(name)}`), `profile.versions lacks ${name}`);
			assert.ok(headers.some((item) => item.name === name && item.version === pinned.get(name)), `no fixture header pins ${name}`);
		}
	});

	test(`${orm}: no completed-support or runtime-tested claim; unadmitted targets claim no support`, () => {
		assert.equal(scope.status.support_completed, false);
		assert.equal(scope.status.runtime_tested, false);
		if (!isPersistenceTargetAdmitted(orm)) assert.deepEqual(scope.constructs.filter((item) => ['supported', 'partial'].includes(item.support)), []);
		assert.ok(scope.constructs.some((item) => item.support === 'unknown'));
	});

	test(`${orm}: provider evidence is deterministic and equals the recorded values`, { skip: skipProvider }, () => {
		const again = computeEvidence(orm, loadScope(orm));
		assert.deepEqual(again, evidenceOf(orm));
		assert.equal(formatScope(applyEvidence(loadScope(orm), again)), raw);
	});

	test(`${orm}: the audit reports no finding`, { skip: skipProvider }, () => {
		assert.deepEqual(auditScope(orm, scope, { evidence: evidenceOf(orm) }).map(formatFinding), []);
	});

	test(`${orm}: negative - a missing pin is reported`, { skip: skipProvider }, () => {
		for (const name of REQUIRED_PINS[orm]) {
			const broken = mutated(orm, (item) => { item.pins.packages = item.pins.packages.filter((pkg) => pkg.name !== name); });
			assert.ok(codesOf(orm, broken).includes('PIN-MISSING'), `${name} removed`);
		}
	});

	test(`${orm}: negative - tampered fixture and oracle hashes are reported`, { skip: skipProvider }, () => {
		const io = diskIo(orm);
		const edit = (target) => ({ ...io, readText: (rel) => io.readText(rel) + (rel === target ? '\n// edited' : '') });
		assert.ok(codesOf(orm, mutated(orm, (item) => { item.cases[0].fixture.files[0].sha256 = '0'.repeat(64); })).includes('FIXTURE-HASH'));
		assert.ok(codesOf(orm, loadScope(orm), edit(files[0].path)).includes('FIXTURE-HASH'));
		assert.ok(codesOf(orm, loadScope(orm), edit(scope.oracle.steps[0].result_file)).includes('STEP-RESULT'));
		assert.ok(codesOf(orm, mutated(orm, (item) => { item.oracle.steps[0].output_bytes += 1; })).includes('STEP-RESULT'));
	});

	test(`${orm}: negative - a construct claimed supported that the provider lacks is rejected`, { skip: skipProvider }, () => {
		const pick = { prisma: 'implicit-many-to-many', typeorm: 'non-primary-columns' }[orm] ?? scope.constructs.find((item) => item.facets.length > 0).id;
		const forged = mutated(orm, (item) => claimSupported(item.constructs.find((construct) => construct.id === pick)));
		const claims = codesOf(orm, forged).filter((code) => code.startsWith('CLAIM-'));
		assert.ok(claims.includes(isPersistenceTargetAdmitted(orm) ? 'CLAIM-OMITS' : 'CLAIM-UNADMITTED'), `${pick}: ${claims}`);
	});
}

test('negative - a file or listing capture without a path and a pre command without argv fail the schema', () => {
	const probes = [
		['file capture', (step) => step.capture.find((part) => part.kind === 'file'), 'path'],
		['listing capture', (step) => step.capture.find((part) => part.kind === 'listing'), 'path'],
		['pre command', (step) => step.pre?.[0], 'argv'],
	];
	for (const [label, pick, field] of probes) {
		const owners = ORMS.filter((orm) => loadScope(orm).oracle.steps.some(pick));
		assert.ok(owners.length > 0, `no record has a ${label}`);
		for (const orm of owners) {
			const broken = mutated(orm, (item) => delete item.oracle.steps.map(pick).find(Boolean)[field]);
			assert.equal(validateScopeSchema(broken).ok, false, `${orm}: ${label} without ${field}`);
		}
	}
});

test('the schema admits a pre-release Node version in the recorded runtime', () => {
	const result = validateScopeSchema(mutated('prisma', (item) => { item.oracle.environment.node = 'v25.0.0-rc.1'; }));
	assert.ok(result.ok, result.errors.join('; '));
});
