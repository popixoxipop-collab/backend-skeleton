#!/usr/bin/env node
// Historical replay (T00-E4): feeds pinned, committed HISTORICAL bytes/records through the CURRENT
// readers and asserts that
//   * the bytes are still exactly the pinned bytes (per-file sha256 + a pinned manifest sha256),
//   * every digest recorded by the OLD code is reproduced by the CURRENT code,
//   * the current interpretation (classification, operation ids, reader name, verdicts) equals the
//     interpretation recorded when the old code read the same bytes,
//   * old evidence stays readable (identity refs, gate attestation, run/evidence binding, protocol
//     item refs) and every record's provenance commit is a 40-hex sha that is a member of
//     PINNED_SNAPSHOT_COMMITS (when the record names a tag, that tag must map to the same commit; a
//     git-historical-bytes record must also carry a non-empty git_path). git is not consulted, so
//     this does not prove the commit still exists in any repository.
// Fixtures live in test/fixtures/historical-replay/ (see manifest.json for per-record provenance and
// scripts/historical-replay-generate.mjs for how they were produced).
//
// Exit code: 0 = every check passed, 1 = at least one check failed, 2 = harness error.
// `npm run test:historical-replay`; also imported by test/historical-replay.test.mjs (which adds the
// negative self-tests and is therefore covered by `npm test` in CI).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { contractSha256, buildOpenApiDocument } from '../contracts/export.mjs';
import { buildContractCsv } from '../contracts/csv.mjs';
import { classifyContract } from '../contracts/completeness.mjs';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';
import { verifyPayload } from '../lib/attest.mjs';
import {
	BINDING_JSON_DOMAIN, bindingDigest, createArtifactRef, artifactRefMatches, assertIdentityEnvelope, readIdentity,
} from '../contracts/next/identity.mjs';
import { buildEvidenceBinding } from '../contracts/reconciliation-next/evidence-binding.mjs';
import { assertT16RuntimeEvidencePair } from '../contracts/reconciliation-next/t16-runtime-evidence.mjs';
import { loadProtocolArtifact } from '../adapters/protocol-next/scanners/protocol-loaders.mjs';
import { buildProtocolContract } from '../adapters/protocol-next/contracts/protocol.mjs';
import {
	assertProtocolItemRefBound, assertProtocolItemRefAgainstContexts, indexProtocolContractContexts,
} from '../adapters/protocol-next/contracts/protocol-item-ref.mjs';
import { buildProtocolOracleRequest, protocolOracleRequestDigest } from '../adapters/protocol-next/contracts/protocol-oracle-request.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_ROOT = path.join(HERE, '..', 'test', 'fixtures', 'historical-replay');
export const MANIFEST_SCHEMA = 'bskel.historical-replay-manifest/1';

// The manifest is the index of the pinned set: it carries every file's sha256, provenance and the
// old code's recorded interpretation. Pinning ITS sha256 here means the set cannot be edited (a
// record swapped, a digest "fixed", an interpretation rewritten) without also editing this line in
// review. Update only via scripts/historical-replay-generate.mjs.
export const PINNED_MANIFEST_SHA256 = 'dd51a7e324ceacc1c745b16282732a46cba36220e11a1731009f954d0672974b';

// Git snapshot refs the set is allowed to cite. A record whose provenance names any other commit is
// rejected, so a fixture cannot silently be re-pinned to a different revision.
export const PINNED_SNAPSHOT_COMMITS = Object.freeze({
	'v1.7.1': '978cdcdcfe8529b580b9f535a06a62ce363a96a2',
	c3422c4: 'c3422c45b14620a8bbda5062d1f4487902d9d5cc',
	ebf7c7e: 'ebf7c7e72338eb1ffb9eedc5767ec2fb5349aac4',
	'152a3fc': '152a3fc6eac518c3f16a7e330ee849075b09b69d',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// overrides: { files: { '<manifest file path>': Buffer } , manifest: Buffer } -- used ONLY by the
// negative self-tests to simulate a corrupted checkout without touching the committed fixtures.
function makeReader(root, overrides = {}) {
	const files = overrides.files ?? {};
	return (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? Buffer.from(files[rel]) : fs.readFileSync(path.join(root, rel)));
}

function listFixtureFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(path.relative(root, full).split(path.sep).join('/'));
		}
	};
	walk(root);
	return out.sort();
}

export function replayHistorical({ root = DEFAULT_FIXTURE_ROOT, pinnedManifestSha256 = PINNED_MANIFEST_SHA256, overrides = {} } = {}) {
	const checks = [];
	const record = (id, fn) => {
		try {
			const detail = fn();
			checks.push({ id, ok: true, detail: typeof detail === 'string' ? detail : undefined });
		} catch (error) {
			checks.push({ id, ok: false, detail: error instanceof Error ? error.message : String(error) });
		}
	};
	const expect = (condition, message) => { if (!condition) throw new Error(message); };
	const expectEqual = (actual, wanted, label) => {
		if (!isDeepStrictEqual(actual, wanted)) {
			throw new Error(`${label}: current=${JSON.stringify(actual)} recorded=${JSON.stringify(wanted)}`);
		}
	};

	const read = makeReader(root, overrides);
	let manifest = null;
	record('manifest:pinned-sha256', () => {
		const bytes = overrides.manifest ? Buffer.from(overrides.manifest) : fs.readFileSync(path.join(root, 'manifest.json'));
		expectEqual(sha256(bytes), pinnedManifestSha256, 'manifest sha256');
		manifest = JSON.parse(bytes.toString('utf8'));
		expect(manifest.schema === MANIFEST_SCHEMA, `unexpected manifest schema ${manifest.schema}`);
	});
	if (manifest === null) {
		// Unpinned/unparseable manifest: nothing further can be trusted. Still try to parse for the checks below? No: fail closed.
		return { ok: false, checks };
	}
	const byId = new Map(manifest.records.map((r) => [r.id, r]));
	const bytesOf = (id) => {
		const rec = byId.get(id);
		if (!rec) throw new Error(`manifest has no record ${id}`);
		return read(rec.file);
	};
	const jsonOf = (id) => JSON.parse(bytesOf(id).toString('utf8'));

	record('manifest:no-unlisted-or-missing-files', () => {
		const listed = manifest.records.map((r) => r.file).concat('manifest.json').sort();
		expectEqual(listFixtureFiles(root), listed, 'fixture file set');
		return `${manifest.records.length} records`;
	});

	for (const rec of manifest.records) {
		record(`${rec.id}:bytes-sha256`, () => {
			expectEqual(sha256(read(rec.file)), rec.sha256, `${rec.file} sha256`);
		});
		record(`${rec.id}:snapshot-ref`, () => {
			const commit = rec.provenance?.commit;
			expect(/^[0-9a-f]{40}$/.test(commit ?? ''), `${rec.id}: provenance.commit is not a full 40-hex sha`);
			expect(Object.values(PINNED_SNAPSHOT_COMMITS).includes(commit), `${rec.id}: provenance.commit ${commit} is not a pinned snapshot`);
			if (rec.provenance.tag) expectEqual(PINNED_SNAPSHOT_COMMITS[rec.provenance.tag], commit, `${rec.id} tag ${rec.provenance.tag}`);
			if (rec.kind === 'git-historical-bytes') expect(typeof rec.provenance.git_path === 'string' && rec.provenance.git_path.length > 0, `${rec.id}: git-historical-bytes needs git_path`);
		});
	}

	// ---- identity goldens (c3422c4 legacy, 152a3fc next): digests + readers -------------------
	record('identity.legacy-golden:digests-and-reader', () => {
		const golden = jsonOf('identity.legacy-golden');
		expectEqual(golden.binding_json, BINDING_JSON_DOMAIN, 'binding-json domain');
		for (const vector of golden.vectors) {
			expectEqual(bindingDigest(vector.kind, vector.value), vector.digest, `legacy vector ${vector.name} digest`);
			const read1 = readIdentity(vector.value);
			expectEqual(read1.reader, 'legacy-identity/1', `legacy vector ${vector.name} reader`);
		}
		const u = golden.unicode_non_normalization;
		expectEqual(bindingDigest(u.kind, u.precomposed.value), u.precomposed.digest, 'unicode precomposed digest');
		expectEqual(bindingDigest(u.kind, u.decomposed.value), u.decomposed.digest, 'unicode decomposed digest');
		expect(u.precomposed.digest !== u.decomposed.digest, 'unicode forms must not be normalized together');
		return `${golden.vectors.length} vectors + unicode pair`;
	});
	record('identity.next-golden:digests-envelope-and-artifact-refs', () => {
		const golden = jsonOf('identity.next-golden');
		for (const vector of golden.envelope_vectors) {
			assertIdentityEnvelope(vector.value);
			expectEqual(bindingDigest(vector.kind, vector.value), vector.digest, `envelope vector ${vector.name} digest`);
			expectEqual(readIdentity(vector.value).reader, 'sbf.identity-envelope/1', `envelope vector ${vector.name} reader`);
		}
		for (const vector of golden.artifact_vectors) {
			expectEqual(createArtifactRef(vector.utf8, { family: vector.ref.family, version: vector.ref.version, media_type: vector.ref.media_type }), vector.ref, `artifact vector ${vector.name} ref`);
			expect(artifactRefMatches(Buffer.from(vector.utf8), vector.ref), `artifact vector ${vector.name} bytes no longer match its ref`);
		}
		return `${golden.envelope_vectors.length} envelope + ${golden.artifact_vectors.length} artifact vectors`;
	});
	record('identity.next-conformance:still-parseable-and-consistent', () => {
		const conformance = jsonOf('identity.next-conformance');
		const golden = jsonOf('identity.next-golden');
		expectEqual(conformance.identity_conformance, 'sbf.identity-conformance/1', 'conformance marker');
		expectEqual(conformance.authority.binding_json, golden.binding_json, 'conformance binding_json authority');
		expectEqual(conformance.authority.envelope_schema, golden.identity_envelope_schema, 'conformance envelope schema authority');
	});

	// ---- gate attestation v1 (ebf7c7e): signature must still verify ---------------------------
	record('evidence.gate-attestation-v1:signature-verifies', () => {
		const attestation = jsonOf('evidence.gate-attestation-v1');
		const pem = bytesOf('evidence.gate-attestation-v1-pubkey').toString('utf8');
		expectEqual(attestation.report.schema, 'sbf.gate-export/1', 'report schema');
		expect(verifyPayload(attestation.report, attestation.signature.value, pem) === true, 'ed25519 signature over the historical report no longer verifies');
	});

	// ---- feature contract (v1.7.1): schema, digest, classification, exports -------------------
	for (const coverage of ['complete', 'partial']) {
		const id = `contract.${coverage}`;
		record(`${id}:interpretation`, () => {
			const rec = byId.get(id);
			const contract = jsonOf(id);
			const schema = validateAgainstSchema('feature-contract.schema.json', contract);
			expect(schema.ok, `contract no longer validates against feature-contract.schema.json: ${formatSchemaErrors(schema.errors).join('; ')}`);
			const current = {
				emit_exit_code: rec.interpretation.emit_exit_code, // exit code is a recorded fact of the old CLI run, not re-derivable from bytes
				sbf_contract: contract.sbf_contract,
				contract_sha256: contractSha256(contract),
				classification: classifyContract({ operations: contract.operations, warnings: contract.warnings }),
				operation_ids: Object.keys(contract.operations).sort(),
			};
			expectEqual(current, rec.interpretation, 'interpretation');
			expectEqual(current.contract_sha256, rec.sha256, 'contract_sha256 vs file sha256');
			expect((coverage === 'complete') === (current.emit_exit_code === 0), 'emit exit code is inconsistent with coverage');
		});
	}
	record('contract.complete.openapi-export:identical-bytes', () => {
		const rec = byId.get('contract.complete.openapi-export');
		const contract = jsonOf(rec.derived_from);
		const built = buildOpenApiDocument({ contract, snapshot: null, options: rec.replay_options });
		expect(built.ok === true, `current openapi export refused the old contract: ${built.error}`);
		const bytes = Buffer.from(`${JSON.stringify(built.document, null, 2)}\n`);
		expect(bytes.equals(bytesOf(rec.id)), `current openapi export bytes differ from the recorded v1.7.1 export (sha256 current=${sha256(bytes)} recorded=${rec.sha256})`);
	});
	record('contract.complete.csv-export:identical-bytes', () => {
		const rec = byId.get('contract.complete.csv-export');
		const built = buildContractCsv({ contract: jsonOf(rec.derived_from) });
		const bytes = Buffer.from(built.csv);
		expect(bytes.equals(bytesOf(rec.id)), `current csv export bytes differ from the recorded v1.7.1 export (sha256 current=${sha256(bytes)} recorded=${rec.sha256})`);
	});

	// ---- T09/T16 run + evidence binding (152a3fc) -----------------------------------------------
	record('run.t16-runtime-run:binding-and-pair-reproduced', () => {
		const run = jsonOf('run.t16-runtime-run');
		const { source, openapi, runtime } = run.inputs;
		expectEqual(buildEvidenceBinding({ source, openapi, runtime }), run.recorded.evidence_binding, 'evidence binding');
		expectEqual(run.recorded.evidence_binding.runtimeBinding.state, 'bound', 'recorded runtimeBinding.state');
		const checked = assertT16RuntimeEvidencePair({
			binding: runtime.binding, bindingHash: runtime.bindingHash, pair: runtime.evidencePair,
			oracleEvidence: runtime.oracleEvidence, candidateEvidence: runtime.candidateEvidence,
		});
		expectEqual(checked.bindingHash, run.recorded.binding_hash, 'runtime binding hash');
		expectEqual(checked.pair, run.recorded.evidence_pair, 'runtime evidence pair');
		expect(artifactRefMatches(Buffer.from(source.bytes), source.artifactRef), 'source bytes no longer match their pinned ArtifactRef');
		expect(artifactRefMatches(Buffer.from(openapi.bytes), openapi.artifactRef), 'openapi bytes no longer match their pinned ArtifactRef');
	});

	// ---- T18 protocol contract, item ref and oracle request (152a3fc) -------------------------------
	record('protocol:contract-item-ref-and-oracle-request', () => {
		const handoff = jsonOf('protocol.t18-handoff-fixture');
		const rec = jsonOf('protocol.item-and-oracle-request');
		const contractBytes = bytesOf('protocol.contract-bytes');
		const contract = JSON.parse(contractBytes.toString('utf8'));
		expect(artifactRefMatches(contractBytes, rec.contract_ref), 'protocol contract bytes no longer match the pinned contract ArtifactRef');
		const scan = loadProtocolArtifact({ family: handoff.source_fixture.family, file: handoff.source_fixture.file, text: handoff.source_fixture.text });
		const rebuilt = Buffer.from(`${JSON.stringify(buildProtocolContract({ featureId: rec.feature_id, featureUid: rec.feature_uid, scan }), null, 2)}\n`);
		expect(rebuilt.equals(contractBytes), `current protocol contract builder output differs from the recorded 152a3fc bytes (sha256 current=${sha256(rebuilt)} recorded=${sha256(contractBytes)})`);
		assertProtocolItemRefBound({ reference: rec.item_ref, contract, contractBytes });
		const contexts = indexProtocolContractContexts([{ contract_ref: rec.contract_ref, contract, contract_bytes: contractBytes }]);
		assertProtocolItemRefAgainstContexts(rec.item_ref, contexts);
		const request = buildProtocolOracleRequest({
			featureId: rec.feature_id, featureUid: rec.feature_uid, scenarioId: rec.oracle_inputs.scenarioId,
			protocolContractRefs: [rec.contract_ref],
			protocolContexts: [{ contract_ref: rec.contract_ref, contract, contract_bytes: contractBytes }],
			originalRef: rec.oracle_inputs.originalRef, candidateRef: rec.oracle_inputs.candidateRef,
			runtimeProfileRef: rec.oracle_inputs.runtimeProfileRef, seed: rec.oracle_inputs.seed,
			assertions: rec.oracle_request.assertions,
		});
		expectEqual(request, rec.oracle_request, 'oracle request');
		expectEqual(protocolOracleRequestDigest(request), rec.oracle_request_digest, 'oracle request digest');
	});

	return { ok: checks.every((c) => c.ok), checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let result;
	try {
		result = replayHistorical();
	} catch (error) {
		console.error(`historical-replay harness error: ${error instanceof Error ? error.stack : error}`);
		process.exit(2);
	}
	for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.detail ? ` -- ${c.detail}` : ''}`);
	const failed = result.checks.filter((c) => !c.ok).length;
	console.log(`historical-replay: ${result.checks.length - failed}/${result.checks.length} checks passed`);
	process.exit(failed === 0 ? 0 : 1);
}
