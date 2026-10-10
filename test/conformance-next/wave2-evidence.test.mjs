import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateMutationGate } from './harness.mjs';
import { validateProductMutationCatalog } from './product-mutation-runner.mjs';

// Verifier for the T19 wave-2 evidence records. Nothing recorded is trusted: report bytes, hashes, statuses, gate,
// counts, anchors, coverage and the survivor register are recomputed from the committed bytes and from the tested
// source commit S read out of Git history. The records are self-computed; no signed attestation exists.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MUTATION_RECORD = 'evidence/next/T19-WAVE2-MUTATION-RECORD.json';
const CROSS_RECORD = 'evidence/next/T19-WAVE2-CROSS-VERSION.json';
const CATALOG_PATH = 'test/conformance-next/product-mutations-wave2.json';
const PILOT_CATALOG_PATH = 'test/conformance-next/product-mutations.json';
const VECTORS_PATH = 'test/corpus-next/negative-vectors.json';
const RUNNER_PATH = 'test/conformance-next/product-mutation-runner.mjs';
const KILLER = 'test/conformance-next/product-wave2-invariants.test.mjs';
const OWN_FILES = [CATALOG_PATH, KILLER, 'test/conformance-next/permission-matrix.json', 'test/conformance-next/permission-matrix.test.mjs'];
const DISPOSITIONS = new Set(['open-test-gap', 'equivalence-unproven']);
const REQUIRED_LIMITS = ['no-attestation', 'survivors-open', 'local-runs-only', 'anchors-valid-at-source-commit-only', 'vectors-without-mutant', 'permission-matrix-is-decision-layer'];

const OFFLINE = process.env.BSKEL_T19_EVIDENCE_OFFLINE === '1';
if (OFFLINE && process.env.CI) throw new Error('BSKEL_T19_EVIDENCE_OFFLINE must not be set when CI is set; history checks may not be skipped in CI');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));
const GIT_ENV = Object.freeze({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
const git = (args) => spawnSync('git', args, { cwd: ROOT, env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 });
const hasCommit = (sha) => git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;

function requireHistory(sha) {
  if (hasCommit(sha)) return;
  const shallow = git(['rev-parse', '--is-shallow-repository']).stdout.toString().trim() === 'true';
  const fetched = git(['fetch', '--no-tags', ...(shallow ? ['--unshallow'] : []), 'origin']);
  assert.equal(hasCommit(sha), true, `source commit ${sha} is not in this checkout and fetching it failed (status ${fetched.status}): ${fetched.stderr}`);
}

const ctx = (sha) => ({
  blob(rel) {
    const r = git(['cat-file', 'blob', `${sha}:${rel}`]);
    assert.equal(r.status, 0, `${rel} is missing at ${sha}: ${r.stderr}`);
    return r.stdout;
  },
  evidence: (rel) => fs.readFileSync(path.join(ROOT, rel)),
});

function readGz(c, rel, gzSha, plainSha) {
  const gz = c.evidence(rel);
  assert.equal(sha256(gz), gzSha, `${rel}: gzip bytes do not match the recorded sha256`);
  const plain = zlib.gunzipSync(gz);
  assert.equal(sha256(plain), plainSha, `${rel}: decompressed bytes do not match the recorded sha256`);
  return plain;
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

function verifyCampaign(run, catalog, S, c) {
  const report = JSON.parse(readGz(c, run.report_file, run.report_gz_sha256, run.report_sha256).toString('utf8'));
  assert.equal(report.contract, 'sbf.qa-product-mutation-report/1');
  assert.equal(report.source_commit, S);
  assert.equal(report.catalog_sha256, sha256(JSON.stringify(catalog)), `${run.id}: catalog digest`);
  assert.deepEqual(report.catalog_errors, []);
  assert.equal(report.dependency_install.package_lock_sha256, sha256(c.blob('package-lock.json')), `${run.id}: lockfile digest`);
  assert.deepEqual(report.mutants.map((m) => m.id), catalog.mutants.map((m) => m.id), `${run.id}: report and catalog must list the same mutants in the same order`);
  const table = report.mutants.map((m, i) => {
    const def = catalog.mutants[i];
    assert.equal(m.vector_id, def.vector_id);
    assert.equal(m.critical, def.critical);
    assert.equal(m.timeout_ms, def.timeout_ms ?? m.timeout_ms);
    assert.ok(Number.isSafeInteger(m.timeout_ms) && m.timeout_ms > 0);
    assert.equal(m.baseline.exit_code, 0, `${m.id}: the unmodified suite must pass or the mutant proves nothing`);
    const killed = Number.isInteger(m.exit_code) && m.exit_code !== 0;
    assert.equal(m.status, killed ? 'killed' : 'survived', `${m.id}: status must follow the exit code`);
    assert.equal(m.classification, killed ? 'mutant-detected' : 'mutant-survived', `${m.id}: a survivor must be a real run, not an unapplied mutant`);
    if (!killed) assert.equal(m.exit_code, 0, `${m.id}: a survivor must have run to completion`);
    return { id: m.id, vector_id: m.vector_id, critical: m.critical, status: m.status, exit_code: m.exit_code, baseline_exit_code: m.baseline.exit_code };
  });
  const gate = evaluateMutationGate({ mutants: report.mutants.map(({ id, critical, status }) => ({ id, critical, status })) });
  assert.deepEqual(report.gate, gate);
  assert.equal(report.pass, gate.pass);
  assert.equal(run.runner_exit_code, gate.pass ? 0 : 3, `${run.id}: runner exit code must follow the gate`);
  assert.equal(run.runner_stderr, `qa-product-mutation: ${gate.pass ? 'PASS' : 'FAIL'} -- ${table.filter((m) => m.status === 'killed').length}/${table.length} mutants killed`);
  assert.deepEqual(run.mutants, table, `${run.id}: the readable table must equal the report`);
  assert.deepEqual(run.summary, {
    total: table.length,
    killed: table.filter((m) => m.status === 'killed').length,
    survived: table.filter((m) => m.status === 'survived').map((m) => m.id),
    critical_failures: gate.critical_failures,
    pass: gate.pass,
  });
  assert.equal(run.command[0], 'node');
  assert.deepEqual(run.command.slice(1, 5), [RUNNER_PATH, '--repo-root', '.', '--catalog']);
  assert.equal(run.command[run.command.indexOf('--source-commit') + 1], S);
  return report;
}

function deriveOwnerOnly(catalog) {
  return { contract: catalog.contract, mutants: catalog.mutants.filter((m) => m.test_files.includes(KILLER)).map((m) => ({ ...m, test_files: m.test_files.filter((f) => f !== KILLER) })) };
}

function verifyMutationRecord(record, S, c) {
  assert.equal(record.contract, 'bskel.t19-wave2-mutation-record/1');
  assert.equal(record.source_commit, S);
  assert.deepEqual(record.attestation, { present: false, reason: record.attestation?.reason });
  assert.equal(typeof record.attestation.reason, 'string');
  const catalogBytes = c.blob(CATALOG_PATH);
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  assert.equal(validateProductMutationCatalog(catalog).ok, true);
  assert.equal(record.catalog.file_sha256, sha256(catalogBytes));
  assert.equal(record.catalog.parsed_sha256, sha256(JSON.stringify(catalog)));
  assert.equal(record.catalog.mutants, catalog.mutants.length);
  assert.ok(catalog.mutants.length >= 21, 'the wave must hold well over twenty mutants');
  for (const input of record.inputs) assert.equal(sha256(c.blob(input.path)), input.sha256, `input ${input.path}`);
  for (const required of [CATALOG_PATH, RUNNER_PATH, VECTORS_PATH, 'package-lock.json', ...OWN_FILES]) {
    assert.equal(record.inputs.some((i) => i.path === required), true, `input list must bind ${required}`);
  }
  const vectors = JSON.parse(c.blob(VECTORS_PATH).toString('utf8')).vectors;
  const vectorById = new Map(vectors.map((v) => [v.id, v]));
  for (const m of catalog.mutants) {
    const vector = vectorById.get(m.vector_id);
    assert.ok(vector, `${m.id}: unknown vector ${m.vector_id}`);
    assert.equal(m.critical, vector.critical === true, `${m.id}: criticality must follow the vector`);
    assert.equal(occurrences(c.blob(m.file).toString('utf8'), m.find), 1, `${m.id}: anchor must occur exactly once at the source commit`);
    for (const t of m.test_files) c.blob(t);
  }
  const wave = record.runs.filter((r) => r.role === 'wave2');
  assert.ok(wave.length >= 2, 'the wave must be run on at least two Node versions');
  assert.equal(new Set(record.runs.map((r) => r.id)).size, record.runs.length);
  const survivedBy = new Map();
  for (const run of wave) {
    assert.equal(run.command[run.command.indexOf('--catalog') + 1], CATALOG_PATH);
    const report = verifyCampaign(run, catalog, S, c);
    for (const m of report.mutants) if (m.status === 'survived') survivedBy.set(m.id, [...(survivedBy.get(m.id) ?? []), run.id]);
  }
  const owner = record.runs.filter((r) => r.role === 'owner-only');
  assert.equal(owner.length, 1);
  const derived = deriveOwnerOnly(catalog);
  assert.deepEqual(owner[0].catalog, derived, 'the owner-only catalog must be the wave catalog without the killer file');
  assert.equal(validateProductMutationCatalog(derived).ok, true);
  const ownerReport = verifyCampaign(owner[0], derived, S, c);
  assert.deepEqual(ownerReport.mutants.map((m) => m.status), derived.mutants.map(() => 'survived'), 'without the killer tests every gap mutant must survive; that is what the killer tests close');
  for (const m of derived.mutants) assert.equal(wave.every((r) => r.mutants.find((x) => x.id === m.id).status === 'killed'), true, `${m.id}: the killer tests must kill it on every wave run`);
  const survivorIds = [...survivedBy.keys()].sort();
  assert.deepEqual(record.survivors.map((s) => s.id).sort(), survivorIds, 'the survivor register must list exactly the recomputed survivors');
  for (const s of record.survivors) {
    const def = catalog.mutants.find((m) => m.id === s.id);
    assert.equal(s.vector_id, def.vector_id);
    assert.equal(s.critical, def.critical);
    assert.deepEqual(s.survived_in, survivedBy.get(s.id));
    assert.ok(DISPOSITIONS.has(s.disposition), `${s.id}: disposition`);
    assert.ok(typeof s.analysis === 'string' && s.analysis.length >= 40, `${s.id}: analysis`);
  }
  const pilot = JSON.parse(c.blob(PILOT_CATALOG_PATH).toString('utf8'));
  const pilotVectors = new Set(pilot.mutants.map((m) => m.vector_id));
  const waveVectors = new Set(catalog.mutants.map((m) => m.vector_id));
  assert.deepEqual([...waveVectors].filter((v) => pilotVectors.has(v)), [], 'wave-2 must only add vectors the pilot catalog left without a mutant');
  assert.deepEqual(record.coverage, {
    negative_vectors: vectors.length,
    pilot_vectors: pilotVectors.size,
    wave2_vectors: waveVectors.size,
    vectors_without_mutant: vectors.map((v) => v.id).filter((id) => !pilotVectors.has(id) && !waveVectors.has(id)),
  });
  assert.deepEqual(record.limits.map((l) => l.id).sort(), [...REQUIRED_LIMITS].sort());
  for (const l of record.limits) assert.ok(typeof l.text === 'string' && l.text.length >= 40, `limit ${l.id}`);
  return { catalog, runs: wave };
}

function parseCounts(text) {
  const out = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const found = [...text.matchAll(new RegExp(`^(?:ℹ|#) ${key} (\\d+)$`, 'gm'))].map((m) => Number(m[1]));
    assert.ok(found.length <= 1, `log has ${found.length} '${key}' summary lines`);
    if (found.length === 1) out[key] = found[0];
  }
  return Object.keys(out).length === 0 ? null : out;
}

function failedTests(text) {
  const names = [...text.matchAll(/^[ \t]*(?:not ok \d+ - |✖ )(.+?)(?: \(\d+(?:\.\d+)?ms\))?[ \t]*$/gm)].map((m) => m[1]).filter((name) => name !== 'failing tests:');
  return [...new Set(names)].sort();
}

function verifySuiteRun(run, S, c) {
  const text = readGz(c, run.log_file, run.log_gz_sha256, run.log_sha256).toString('utf8');
  const header = {};
  for (const m of text.matchAll(/^# bskel-evidence: ([a-z_]+)=(.*)$/gm)) {
    assert.equal(m[1] in header, false, `duplicate header ${m[1]}`);
    header[m[1]] = m[2];
  }
  assert.equal(header.source_commit, S);
  assert.equal(header.node.split(' ')[0], run.node_version);
  assert.equal(header.command, run.command);
  assert.equal(run.command, `node scripts/run-next-nested-tests.mjs ${run.suite}`);
  assert.equal(Number(header.exit_code), run.exit_code);
  const counts = parseCounts(text);
  assert.deepEqual(run.counts, counts);
  if (counts) assert.equal(counts.tests, counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo, 'summary counts must add up');
  const failed = failedTests(text);
  assert.deepEqual(run.failed_tests, failed, `${run.suite}@${run.node_version}: failed_tests must equal the failures printed in the log`);
  assert.ok(run.attempt === 1 || run.attempt === 2, 'attempt must be 1 or 2');
  if (run.exit_code === 0) {
    assert.ok(counts && counts.tests > 0 && counts.fail === 0 && counts.cancelled === 0, 'a zero exit needs a non-empty, failure-free summary');
    assert.deepEqual(failed, [], 'a zero exit must not print failures');
  } else {
    assert.ok(failed.length > 0 || (counts && (counts.fail > 0 || counts.cancelled > 0)), 'a non-zero exit must show its failures in the log');
  }
}

function verifyCrossRecord(cross, mutation, S, c) {
  assert.equal(cross.contract, 'bskel.t19-wave2-cross-version/1');
  assert.equal(cross.source_commit, S);
  assert.equal(cross.attestation.present, false);
  assert.equal(JSON.parse(c.blob('package.json').toString('utf8')).engines.node, cross.declared.engines_node);
  const ci = c.blob('.github/workflows/ci.yml').toString('utf8');
  const start = ci.indexOf('\n  nested-next:\n');
  assert.ok(start >= 0, 'nested-next job not found at the source commit');
  const body = ci.slice(start + 1).split('\n');
  const end = body.findIndex((line, i) => i > 0 && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  const matrix = body.slice(0, end < 0 ? body.length : end).join('\n').match(/node:\s*\[([^\]]*)\]/);
  assert.ok(matrix, 'nested-next node matrix not found');
  assert.deepEqual(matrix[1].split(',').map((x) => x.trim().replace(/['"]/g, '')), cross.declared.ci_matrix_node);
  assert.ok(cross.suite_runs.length > 0);
  const seen = new Set();
  for (const run of cross.suite_runs) {
    const key = `${run.suite}@${run.node_version}#${run.attempt}`;
    assert.equal(seen.has(key), false, `duplicate ${key}`);
    seen.add(key);
    verifySuiteRun(run, S, c);
  }
  let green = true;
  for (const major of cross.declared.ci_matrix_node.map((v) => v.split('.')[0])) {
    for (const suite of ['T19', 'T20']) {
      const runs = cross.suite_runs.filter((r) => r.suite === suite && r.node_version.startsWith(`v${major}.`));
      assert.ok(runs.length > 0, `no ${suite} run on Node ${major}`);
      const last = runs.reduce((x, y) => (y.attempt > x.attempt ? y : x));
      if (last.exit_code !== 0) green = false;
    }
  }
  assert.equal(cross.matrix_green, green, 'matrix_green must follow the last attempt of every CI-matrix run');
  if (!green || cross.suite_runs.some((r) => r.exit_code !== 0)) {
    assert.ok(cross.limits.some((l) => l.id === 'suite-failures-open' && l.text.length >= 40), 'recorded suite failures need a suite-failures-open limit');
  }
  const [a, b] = cross.mutation_verdicts.compared_runs.map((id) => mutation.runs.find((r) => r.id === id));
  assert.ok(a && b && a.node_version !== b.node_version);
  const differences = a.mutants.filter((m, i) => m.status !== b.mutants[i].status || m.exit_code !== b.mutants[i].exit_code).map((m) => m.id);
  assert.deepEqual(cross.mutation_verdicts, { compared_runs: cross.mutation_verdicts.compared_runs, mutants_compared: a.mutants.length, differences });
  assert.ok(cross.not_run.every((n) => ['BLOCKED', 'NOT-RUN'].includes(n.status) && n.reason.length >= 20));
}

const mutationRecord = readJson(MUTATION_RECORD);
const crossRecord = readJson(CROSS_RECORD);
const S = mutationRecord.source_commit;

test('wave-2 evidence: both records name the same canonical source commit and carry no attestation', () => {
  assert.match(S, /^[a-f0-9]{40}$/);
  assert.equal(crossRecord.source_commit, S);
  assert.equal(mutationRecord.attestation.present, false);
  assert.equal(crossRecord.attestation.present, false);
});

test('wave-2 evidence: the working tree still holds the exact T19-owned files the records were produced from', () => {
  for (const rel of OWN_FILES) {
    const recorded = mutationRecord.inputs.find((i) => i.path === rel);
    assert.ok(recorded, rel);
    assert.equal(sha256(fs.readFileSync(path.join(ROOT, rel))), recorded.sha256, `${rel} changed after the evidence was recorded; re-run the campaigns and refresh the records`);
  }
});

test('wave-2 evidence: the source commit is reachable and an ancestor of HEAD', (t) => {
  if (OFFLINE) return t.skip('BSKEL_T19_EVIDENCE_OFFLINE=1');
  requireHistory(S);
  assert.equal(git(['merge-base', '--is-ancestor', S, 'HEAD']).status, 0, 'the tested source commit must be an ancestor of HEAD');
});

test('wave-2 evidence: the mutation record recomputes from the tested commit and the committed reports', (t) => {
  if (OFFLINE) return t.skip('BSKEL_T19_EVIDENCE_OFFLINE=1');
  requireHistory(S);
  verifyMutationRecord(mutationRecord, S, ctx(S));
});

test('wave-2 evidence: the cross-version record recomputes from the committed logs and the mutation record', (t) => {
  if (OFFLINE) return t.skip('BSKEL_T19_EVIDENCE_OFFLINE=1');
  requireHistory(S);
  const c = ctx(S);
  const { runs } = verifyMutationRecord(mutationRecord, S, c);
  verifyCrossRecord(crossRecord, { runs }, S, c);
});

test('wave-2 evidence: tampering with any recorded value, report byte or log byte is detected', (t) => {
  if (OFFLINE) return t.skip('BSKEL_T19_EVIDENCE_OFFLINE=1');
  requireHistory(S);
  const c = ctx(S);
  const tamper = (fn) => {
    const copy = structuredClone(mutationRecord);
    fn(copy);
    assert.throws(() => verifyMutationRecord(copy, S, c), `tampering was not detected: ${fn}`);
  };
  tamper((r) => { r.runs[0].mutants[0].status = r.runs[0].mutants[0].status === 'killed' ? 'survived' : 'killed'; });
  tamper((r) => { r.runs[0].runner_exit_code = r.runs[0].runner_exit_code === 0 ? 3 : 0; });
  tamper((r) => { r.catalog.file_sha256 = '0'.repeat(64); });
  tamper((r) => { r.inputs[0].sha256 = '1'.repeat(64); });
  tamper((r) => { r.survivors.pop(); });
  tamper((r) => { r.runs[0].report_gz_sha256 = '2'.repeat(64); });
  tamper((r) => { r.coverage.vectors_without_mutant.pop(); });
  const flipped = { ...c, evidence: (rel) => { const b = Buffer.from(c.evidence(rel)); if (rel === mutationRecord.runs[1].report_file) b[b.length >> 1] ^= 1; return b; } };
  assert.throws(() => verifyMutationRecord(mutationRecord, S, flipped), 'a flipped report byte must be detected');
  const logs = (fn) => {
    const copy = structuredClone(crossRecord);
    fn(copy);
    const runs = mutationRecord.runs.filter((r) => r.role === 'wave2');
    assert.throws(() => verifyCrossRecord(copy, { runs }, S, c), `tampering was not detected: ${fn}`);
  };
  logs((r) => { r.suite_runs[0].counts.pass += 1; });
  logs((r) => { r.suite_runs[0].exit_code = r.suite_runs[0].exit_code === 0 ? 1 : 0; });
  logs((r) => { r.suite_runs[0].log_sha256 = '3'.repeat(64); });
  logs((r) => { r.declared.ci_matrix_node = ['22.x']; });
});
