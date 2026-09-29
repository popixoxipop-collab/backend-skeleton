#!/usr/bin/env node
// Fixture GENERATOR for scripts/historical-replay.mjs (T00-E4). Not run in CI: it exists so the
// committed fixtures under test/fixtures/historical-replay/ are reproducible and their provenance
// is auditable, not hand-written.
//
// Two kinds of record are produced, and the manifest states which is which per record:
//   * git-historical-bytes -- byte-exact `git show <commit>:<path>` copies of files that were
//     committed at an old revision (nothing synthesized, nothing re-serialized).
//   * old-code-generated   -- produced by running the REAL code of an OLD revision (a git worktree
//     of that revision, never the current tree) and recording its output + the sha256 digests that
//     old code computed. These are the "recorded" interpretations the replay compares against.
//
// Usage (from a clone of backend-skeleton that has full history and node_modules installed):
//   git worktree add --detach ../old-v1.7.1   978cdcdcfe8529b580b9f535a06a62ce363a96a2
//   git worktree add --detach ../old-152a3fc  152a3fc6eac518c3f16a7e330ee849075b09b69d
//   ln -s "$PWD/node_modules" ../old-v1.7.1/node_modules ; ln -s "$PWD/node_modules" ../old-152a3fc/node_modules
//   node scripts/historical-replay-generate.mjs --contract-root ../old-v1.7.1 --tseries-root ../old-152a3fc
// NOTE: the v1.7.1 contract records embed a random feature_uid minted by `feature init`, so a
// regeneration is NOT byte-identical to the committed set (the committed set is the pinned truth).
// Then update PINNED_MANIFEST_SHA256 in scripts/historical-replay.mjs to the sha256 printed at the end.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT = path.join(REPO, 'test', 'fixtures', 'historical-replay');

const REVS = {
  'v1.7.1': '978cdcdcfe8529b580b9f535a06a62ce363a96a2',
  c3422c4: 'c3422c45b14620a8bbda5062d1f4487902d9d5cc',
  ebf7c7e: 'ebf7c7e72338eb1ffb9eedc5767ec2fb5349aac4',
  '152a3fc': '152a3fc6eac518c3f16a7e330ee849075b09b69d',
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return path.resolve(process.argv[i + 1]);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const records = [];

function write(rel, bytes) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return sha256(fs.readFileSync(file));
}

function gitHistorical(id, rel, revKey, gitPath, extra = {}) {
  const commit = REVS[revKey];
  const bytes = execFileSync('git', ['-C', REPO, 'show', `${commit}:${gitPath}`], { maxBuffer: 64 * 1024 * 1024 });
  records.push({
    id, kind: 'git-historical-bytes', file: rel, sha256: write(rel, bytes),
    provenance: { repo: 'popixoxipop-collab/backend-skeleton', commit, git_path: gitPath },
    ...extra,
  });
}

function generated(id, rel, bytes, provenance, extra = {}) {
  records.push({ id, kind: 'old-code-generated', file: rel, sha256: write(rel, bytes), provenance, ...extra });
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// ---- 1. byte-exact historical files -------------------------------------------------------------
function historicalBytes() {
  gitHistorical('identity.legacy-golden', 'identity/contract-identity.golden.c3422c4.json', 'c3422c4', 'schemas/contract-identity.golden.json');
  gitHistorical('identity.next-golden', 'identity/identity.golden.152a3fc.json', '152a3fc', 'schemas/next/identity.golden.json');
  gitHistorical('identity.next-conformance', 'identity/identity-conformance.152a3fc.json', '152a3fc', 'schemas/next/identity-conformance.json');
  gitHistorical('evidence.gate-attestation-v1', 'evidence/gate-attestation-v1.ebf7c7e.json', 'ebf7c7e', 'test/fixtures/gate-attestation-v1.json');
  gitHistorical('evidence.gate-attestation-v1-pubkey', 'evidence/gate-attestation-v1.ebf7c7e.pub.pem', 'ebf7c7e', 'test/fixtures/gate-attestation-v1.pub.pem');
  gitHistorical('protocol.t18-handoff-fixture', 'protocol/t16-grpc-unary-evidence-handoff.152a3fc.json', '152a3fc', 'test/protocol-next/fixtures/t16-grpc-unary-evidence-handoff.json');
}

// ---- 2. feature contract records emitted by the released v1.7.1 CLI ---------------------------
async function contractRecords(root) {
  const helper = await import(pathToFileURL(path.join(root, 'test', '_contract-fixture.mjs')).href);
  const oldExport = await import(pathToFileURL(path.join(root, 'contracts', 'export.mjs')).href);
  const oldCsv = await import(pathToFileURL(path.join(root, 'contracts', 'csv.mjs')).href);
  const oldCompleteness = await import(pathToFileURL(path.join(root, 'contracts', 'completeness.mjs')).href);
  const feature = '001-widget-management';
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (commit !== REVS['v1.7.1']) throw new Error(`--contract-root must be at ${REVS['v1.7.1']}, got ${commit}`);
  const provenance = { repo: 'popixoxipop-collab/backend-skeleton', commit, tag: 'v1.7.1', generator: `bskel ${version} CLI (contract emit/export/export-csv) via that revision's test/_contract-fixture.mjs` };

  for (const coverage of ['complete', 'partial']) {
    const repo = helper.buildFixtureRepo({ coverage });
    helper.initThroughScanDisposition(repo);
    const emit = helper.run(['contract', 'emit', '--feature', feature], repo);
    const bytes = fs.readFileSync(helper.contractSchemaPath(repo));
    const contract = JSON.parse(bytes.toString('utf8'));
    const interpretation = {
      emit_exit_code: emit.code,
      sbf_contract: contract.sbf_contract,
      contract_sha256: oldExport.contractSha256(contract),
      classification: oldCompleteness.classifyContract({ operations: contract.operations, warnings: contract.warnings }),
      operation_ids: Object.keys(contract.operations).sort(),
    };
    const rel = `contract/${feature}.${coverage}.v1.7.1.schema.json`;
    records.push({ id: `contract.${coverage}`, kind: 'old-code-generated', file: rel, sha256: write(rel, bytes), provenance, interpretation });
    if (coverage !== 'complete') continue;
    // Export views are gated on a passing `contract` gate; the complete fixture passes it.
    const built = oldExport.buildOpenApiDocument({ contract, snapshot: null, options: { statusCodes: 'range', exportedBy: `bskel ${version}` } });
    if (!built.ok) throw new Error(`old openapi export failed: ${built.error}`);
    const cli = helper.run(['contract', 'export', '--feature', feature, '--out', 'exported.json'], repo);
    const cliBytes = fs.readFileSync(path.join(repo, 'exported.json'));
    const libBytes = Buffer.from(`${JSON.stringify(built.document, null, 2)}\n`);
    if (cli.code !== 0 || !cliBytes.equals(libBytes)) throw new Error('old CLI export bytes differ from old library export bytes');
    generated('contract.complete.openapi-export', `contract/${feature}.complete.v1.7.1.export.openapi.json`, cliBytes, provenance, {
      derived_from: 'contract.complete',
      replay_options: { statusCodes: 'range', exportedBy: `bskel ${version}` },
    });
    const csvRun = helper.run(['contract', 'export-csv', '--feature', feature, '--out', 'ops.csv'], repo);
    const csvBytes = fs.readFileSync(path.join(repo, 'ops.csv'));
    const csv = oldCsv.buildContractCsv({ contract });
    if (csvRun.code !== 0 || !csvBytes.equals(Buffer.from(csv.csv))) throw new Error('old CLI csv bytes differ from old library csv bytes');
    generated('contract.complete.csv-export', `contract/${feature}.complete.v1.7.1.export.csv`, csvBytes, provenance, { derived_from: 'contract.complete' });
  }
}

// ---- 3. T-series run/evidence + protocol records produced by 152a3fc code -----------------------
async function tseriesRecords(root) {
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (commit !== REVS['152a3fc']) throw new Error(`--tseries-root must be at ${REVS['152a3fc']}, got ${commit}`);
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const fx = await imp('test/reconciliation-next/approved-evidence-fixture.mjs');
  const eb = await imp('contracts/reconciliation-next/evidence-binding.mjs');
  const provenance = { repo: 'popixoxipop-collab/backend-skeleton', commit, generator: `T09/T16 evidence-binding code at ${commit}, inputs from that revision's test/reconciliation-next/approved-evidence-fixture.mjs` };

  const source = fx.sourceInput();
  const openapi = fx.openapiInput();
  const { runtime } = fx.runtimeInput({ source, openapi });
  const binding = eb.buildEvidenceBinding({ source, openapi, runtime });
  if (binding.runtimeBinding.state !== 'bound') throw new Error('old code did not bind its own fixture');
  generated('run.t16-runtime-run', 'run/t16-runtime-run.152a3fc.json', json({
    inputs: { source, openapi, runtime },
    recorded: { evidence_binding: binding, binding_hash: runtime.bindingHash, evidence_pair: runtime.evidencePair },
  }), provenance);

  const protocolScan = await imp('adapters/protocol-next/scanners/protocol-loaders.mjs');
  const protocol = await imp('adapters/protocol-next/contracts/protocol.mjs');
  const itemRef = await imp('adapters/protocol-next/contracts/protocol-item-ref.mjs');
  const oracle = await imp('adapters/protocol-next/contracts/protocol-oracle-request.mjs');
  const handoff = JSON.parse(fs.readFileSync(path.join(OUT, 'protocol', 't16-grpc-unary-evidence-handoff.152a3fc.json'), 'utf8'));
  const featureId = 'grpc-unary-profile';
  const featureUid = '11111111-1111-4111-8111-111111111111';
  const scan = protocolScan.loadProtocolArtifact({ family: handoff.source_fixture.family, file: handoff.source_fixture.file, text: handoff.source_fixture.text });
  const contract = protocol.buildProtocolContract({ featureId, featureUid, scan });
  const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  const contractRef = {
    artifact_ref: 'sbf.artifact-ref/1', family: 'protocol-contract', version: '1', media_type: 'application/json',
    byte_sha256: sha256(contractBytes), size_bytes: contractBytes.byteLength,
  };
  const method = contract.planes.grpc.methods.find((m) => m.service === handoff.profile.static_selector.service && m.name === handoff.profile.static_selector.method);
  const actionRef = itemRef.bindProtocolItemRef({ contractRef, contract, contractBytes, family: 'grpc', plane: 'methods', itemId: method.id });
  const ref = (text, family, mediaType = 'application/json') => ({
    artifact_ref: 'sbf.artifact-ref/1', family, version: '1', media_type: mediaType,
    byte_sha256: sha256(Buffer.from(text)), size_bytes: Buffer.byteLength(text),
  });
  const originalRef = ref('original-grpc-unary-fixture-v1\n', 'runtime-original', 'application/octet-stream');
  const candidateRef = ref('candidate-grpc-unary-fixture-v1\n', 'runtime-candidate', 'application/octet-stream');
  const runtimeProfileRef = ref(`${JSON.stringify({ runtime_profile: handoff.profile.id, runtime_execution: handoff.profile.runtime_execution })}\n`, 'runtime-profile');
  const request = oracle.buildProtocolOracleRequest({
    featureId, featureUid, scenarioId: 'orders-get', protocolContractRefs: [contractRef],
    protocolContexts: [{ contract_ref: contractRef, contract, contract_bytes: contractBytes }],
    originalRef, candidateRef, runtimeProfileRef, seed: '7',
    assertions: [{ id: 'grpc-orders-get-status', kind: 'grpc-status', action_ref: actionRef, expect: { status: 'OK' } }],
  });
  const pprov = { ...provenance, generator: `T18 protocol-next code at ${commit} over the byte-exact handoff fixture protocol/t16-grpc-unary-evidence-handoff.152a3fc.json` };
  generated('protocol.contract-bytes', 'protocol/protocol-contract.152a3fc.json', contractBytes, pprov);
  generated('protocol.item-and-oracle-request', 'protocol/protocol-item-ref-and-oracle-request.152a3fc.json', json({
    feature_id: featureId, feature_uid: featureUid, contract_ref: contractRef, item_ref: actionRef,
    oracle_request: request, oracle_request_digest: oracle.protocolOracleRequestDigest(request),
    oracle_inputs: { scenarioId: 'orders-get', seed: '7', originalRef, candidateRef, runtimeProfileRef },
  }), pprov);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
historicalBytes();
await contractRecords(arg('contract-root'));
await tseriesRecords(arg('tseries-root'));

const manifest = {
  schema: 'bskel.historical-replay-manifest/1',
  note: 'Pinned historical records. Every file is listed with its sha256; scripts/historical-replay.mjs pins this manifest\'s own sha256. Regenerate only with scripts/historical-replay-generate.mjs.',
  records: records.sort((a, b) => a.id.localeCompare(b.id)),
};
const manifestBytes = json(manifest);
fs.writeFileSync(path.join(OUT, 'manifest.json'), manifestBytes);
console.log(`wrote ${records.length} records; manifest sha256 = ${sha256(manifestBytes)}`);
