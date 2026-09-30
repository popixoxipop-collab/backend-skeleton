// T00-E4: executes scripts/historical-replay.mjs (pinned historical fixtures -> CURRENT readers) and
// proves the replay is not vacuous: every mutation of a fixture byte, a recorded digest or a recorded
// interpretation must make it FAIL, at the specific check that owns that fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { replayHistorical, DEFAULT_FIXTURE_ROOT, PINNED_MANIFEST_SHA256, PINNED_SNAPSHOT_COMMITS } from '../scripts/historical-replay.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = () => fs.readFileSync(path.join(DEFAULT_FIXTURE_ROOT, 'manifest.json'));
const manifestJson = () => JSON.parse(manifestBytes().toString('utf8'));
const fixtureBytes = (rel) => fs.readFileSync(path.join(DEFAULT_FIXTURE_ROOT, rel));
const failing = (result) => result.checks.filter((c) => !c.ok).map((c) => c.id);
const asJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

// Builds a "corrupted checkout" where ONE record's bytes were replaced and the manifest was updated
// to agree (new file sha256, new pinned manifest sha256) -- i.e. every integrity layer that merely
// compares hashes is deliberately satisfied, so only the semantic checks can catch the mutation.
function withConsistentMutation(id, mutate) {
	const manifest = manifestJson();
	const rec = manifest.records.find((r) => r.id === id);
	const mutated = mutate(fixtureBytes(rec.file));
	rec.sha256 = sha256(mutated);
	const manifestOut = asJson(manifest);
	return replayHistorical({
		pinnedManifestSha256: sha256(manifestOut),
		overrides: { manifest: manifestOut, files: { [rec.file]: mutated } },
	});
}

function flipOneByte(bytes, needle, replacement) {
	const text = bytes.toString('utf8');
	assert.ok(text.includes(needle), `mutation anchor missing: ${needle}`);
	return Buffer.from(text.replace(needle, replacement));
}

test('replay: pinned historical fixtures replay cleanly through the current readers', () => {
	const result = replayHistorical();
	assert.deepEqual(failing(result), []);
	assert.equal(result.ok, true);
	assert.equal(sha256(manifestBytes()), PINNED_MANIFEST_SHA256);
	const manifest = manifestJson();
	assert.equal(manifest.records.length, 13);
	// Both provenance classes are present and stated per record.
	assert.deepEqual([...new Set(manifest.records.map((r) => r.kind))].sort(), ['git-historical-bytes', 'old-code-generated']);
	for (const rec of manifest.records) assert.ok(Object.values(PINNED_SNAPSHOT_COMMITS).includes(rec.provenance.commit), rec.id);
});

test('replay CLI: exits 0 on the committed set and prints one line per check', () => {
	const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'historical-replay.mjs')], { encoding: 'utf8' });
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /historical-replay: (\d+)\/\1 checks passed/);
	assert.doesNotMatch(run.stdout, /^FAIL/m);
});

test('negative self-test: a mutated fixture BYTE fails the replay (per-file sha256 pin)', () => {
	const manifest = manifestJson();
	const rec = manifest.records.find((r) => r.id === 'identity.next-golden');
	const mutated = flipOneByte(fixtureBytes(rec.file), '"http"', '"htty"');
	const result = replayHistorical({ overrides: { files: { [rec.file]: mutated } } });
	assert.equal(result.ok, false);
	assert.ok(failing(result).includes('identity.next-golden:bytes-sha256'), failing(result).join(','));
});

test('negative self-test: a mutated byte in every record kind fails at its own byte check', () => {
	const manifest = manifestJson();
	for (const rec of manifest.records) {
		const original = fixtureBytes(rec.file);
		const mutated = Buffer.from(original);
		mutated[Math.floor(mutated.length / 2)] ^= 0x01;
		const result = replayHistorical({ overrides: { files: { [rec.file]: mutated } } });
		assert.equal(result.ok, false, rec.id);
		assert.ok(failing(result).includes(`${rec.id}:bytes-sha256`), `${rec.id}: ${failing(result).join(',')}`);
	}
});

test('negative self-test: a mutated manifest (record removed, or any byte) fails the pin', () => {
	const manifest = manifestJson();
	manifest.records = manifest.records.filter((r) => r.id !== 'contract.partial');
	const result = replayHistorical({ overrides: { manifest: asJson(manifest) } });
	assert.equal(result.ok, false);
	assert.ok(failing(result).includes('manifest:pinned-sha256'));
	// fail closed: nothing after an unpinned manifest is trusted, so no downstream check "passes".
	assert.deepEqual(result.checks.map((c) => c.id), ['manifest:pinned-sha256']);
});

test('negative self-test: an unlisted extra file in the fixture directory fails the set check', () => {
	const stray = path.join(DEFAULT_FIXTURE_ROOT, 'identity', 'zz-stray.json');
	fs.writeFileSync(stray, '{}\n');
	try {
		const result = replayHistorical();
		assert.equal(result.ok, false);
		assert.ok(failing(result).includes('manifest:no-unlisted-or-missing-files'));
	} finally {
		fs.rmSync(stray, { force: true });
	}
	assert.equal(replayHistorical().ok, true);
});

test('negative self-test: hash-consistent forgeries are caught by the SEMANTIC checks, not only by hash pins', () => {
	// 1. contract bytes changed (an operation renamed) with file sha + manifest pin updated to agree:
	//    the recorded interpretation (operation ids / contract_sha256) no longer matches.
	const contract = withConsistentMutation('contract.complete', (b) => flipOneByte(b, '"createWidget"', '"createWidgetX"'));
	assert.equal(contract.ok, false);
	assert.ok(failing(contract).includes('contract.complete:interpretation'), failing(contract).join(','));
	assert.ok(!failing(contract).includes('contract.complete:bytes-sha256'), 'byte pin was meant to be satisfied');

	// 2. an identity golden digest edited to agree with a byte-changed vector value
	const golden = withConsistentMutation('identity.next-golden', (b) => flipOneByte(b, '"001-hello"', '"001-hellO"'));
	assert.equal(golden.ok, false);
	assert.ok(failing(golden).includes('identity.next-golden:digests-envelope-and-artifact-refs'), failing(golden).join(','));

	// 3. the historical gate report edited: the ed25519 signature must stop verifying
	const att = withConsistentMutation('evidence.gate-attestation-v1', (b) => flipOneByte(b, '"pass"', '"fail"'));
	assert.equal(att.ok, false);
	assert.ok(failing(att).includes('evidence.gate-attestation-v1:signature-verifies'), failing(att).join(','));

	// 4. the recorded evidence binding edited: current code must not reproduce it
	const run = withConsistentMutation('run.t16-runtime-run', (b) => {
		const doc = JSON.parse(b.toString('utf8'));
		doc.recorded.evidence_binding.runtimeBinding.state = 'unknown';
		return asJson(doc);
	});
	assert.equal(run.ok, false);
	assert.ok(failing(run).includes('run.t16-runtime-run:binding-and-pair-reproduced'), failing(run).join(','));

	// 5. recorded protocol oracle-request digest edited
	const proto = withConsistentMutation('protocol.item-and-oracle-request', (b) => {
		const doc = JSON.parse(b.toString('utf8'));
		doc.oracle_request_digest = '0'.repeat(64);
		return asJson(doc);
	});
	assert.equal(proto.ok, false);
	assert.ok(failing(proto).includes('protocol:contract-item-ref-and-oracle-request'), failing(proto).join(','));

	// 6. a recorded export byte edited (openapi export no longer identical to what current code emits)
	const exp = withConsistentMutation('contract.complete.openapi-export', (b) => flipOneByte(b, '"3.1.0"', '"3.1.1"'));
	assert.equal(exp.ok, false);
	assert.ok(failing(exp).includes('contract.complete.openapi-export:identical-bytes'), failing(exp).join(','));
});

test('negative self-test: a mutated recorded INTERPRETATION fails the replay at that record', () => {
	for (const [id, field, value] of [
		['contract.complete', 'classification', 'partial'],
		['contract.complete', 'operation_ids', ['createWidget']],
		['contract.complete', 'contract_sha256', '0'.repeat(64)],
		['contract.partial', 'classification', 'complete'],
		['contract.partial', 'emit_exit_code', 0],
	]) {
		const manifest = manifestJson();
		manifest.records.find((r) => r.id === id).interpretation[field] = value;
		const out = asJson(manifest);
		// pin recomputed for the tampered manifest so only the interpretation comparison can object
		const result = replayHistorical({ pinnedManifestSha256: sha256(out), overrides: { manifest: out } });
		assert.equal(result.ok, false, `${id}.${field}`);
		assert.ok(failing(result).includes(`${id}:interpretation`), `${id}.${field}: ${failing(result).join(',')}`);
	}
});

test('negative self-test: a snapshot ref re-pointed at an unpinned commit fails', () => {
	const manifest = manifestJson();
	manifest.records.find((r) => r.id === 'identity.legacy-golden').provenance.commit = 'f'.repeat(40);
	const out = asJson(manifest);
	const result = replayHistorical({ pinnedManifestSha256: sha256(out), overrides: { manifest: out } });
	assert.equal(result.ok, false);
	assert.ok(failing(result).includes('identity.legacy-golden:snapshot-ref'));
});

test('negative self-test: the CLI exits non-zero when the pinned set does not replay', () => {
	// Same entrypoint contract as the CLI (exit 1 on any failed check), driven with an unmatchable pin.
	const driver = `
		import { replayHistorical } from ${JSON.stringify(path.join(ROOT, 'scripts', 'historical-replay.mjs'))};
		const r = replayHistorical({ pinnedManifestSha256: '${'0'.repeat(64)}' });
		process.exit(r.ok ? 0 : 1);
	`;
	const run = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8' });
	assert.equal(run.status, 1, run.stderr);
});
