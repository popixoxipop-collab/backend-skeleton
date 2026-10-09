// The seven HTTP "-01" target scope records (T11 Express x2, T12 Fastify/NestJS, T13 Hono/Koa/Next.js) share one
// verifier. This is the only test for them; it lives in the T11 test dir and runs through
// `node scripts/run-next-nested-tests.mjs T11` (CI job nested-next, Node 22.x and 24.x). Nothing here is skipped:
// a missing record, directory, file or scanner is an error, and every tamper case must be reported by the verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRecords, verifyRecord, sealOf, repoRoot } from '../../adapters/http-legacy-next/scope/verify.mjs';

const loaded = loadRecords();
const byItem = Object.fromEntries(loaded.map(({ record }) => [record.item, record]));
const TS = 'HTTP-typescript-express-01', JS = 'HTTP-javascript-express-01', FY = 'HTTP-node-fastify-01', NX = 'HTTP-typescript-nextjs-01';
// Every number the PR body quotes: status, caught/left-unknown/silent-miss (or the BLOCKED code), false routes on the
// counterexample fixture, routes emitted on the normal fixture, and recorded steps. They are re-derived from the records,
// which verifyRecord has already recomputed against the live scanner, the oracle output and the files.
const EXPECT = {
  [TS]: 'T11 RUN 2/0/7 false4 emits6 steps10', [JS]: 'T11 RUN 2/0/7 false4 emits6 steps10',
  [FY]: 'T12 BLOCKED FASTIFY_UPSTREAM_RECEIVER_FACT_MISSING steps6', 'HTTP-typescript-nestjs-01': 'T12 BLOCKED NESTJS_STRUCTURE_FACT_PRODUCER_MISSING steps13',
  'HTTP-node-hono-01': 'T13 RUN 2/6/1 false3 emits6 steps5', 'HTTP-node-koa-01': 'T13 RUN 1/6/2 false0 emits6 steps6', [NX]: 'T13 RUN 1/3/3 false0 emits8 steps11',
};
const summary = (r) => {
  const c = r.conformance, v = c.verdictCounts;
  return c.status === 'RUN' ? `${r.track} RUN ${v.caught}/${v['left-unknown']}/${v['silent-miss']} false${c.falseRoutes.counterexample.length} emits${c.emitted.normal.length} steps${r.runs.length}` : `${r.track} BLOCKED ${c.code} steps${r.runs.length}`;
};

test('exactly the seven records exist, in the directory of their track, and each verifies clean', async () => {
  assert.deepEqual(loaded.map(({ record }) => record.item).sort(), Object.keys(EXPECT).sort());
  for (const { file, record } of loaded) {
    assert.equal(path.basename(file), `${record.scanner.runner}.SCOPE.json`);
    assert.equal(file.split('/')[1], { T11: 'http-legacy-next', T12: 'http-wave-a', T13: 'http-wave-bc' }[record.track], file);
    assert.deepEqual(await verifyRecord(record), [], file);
    assert.equal(summary(record), EXPECT[record.item], record.item);
    assert.equal(record.claim.registrationAloneIsSupport, false);
    assert.ok(record.mustCatch.length >= 4 && record.unsupported.length > 0, `${record.item} needs unsupported[] and a must-catch list`);
    if (record.conformance.status === 'RUN') assert.ok(record.supported.length > 0, `${record.item} is RUN, so it must list what it supports`);
  }
});

test('the two Express targets share one run and one pin but keep distinct records', () => {
  const [a, b] = [byItem[TS], byItem[JS]];
  assert.notEqual(a.item, b.item);
  assert.notEqual(a.target, b.target);
  assert.deepEqual(a.runs, b.runs);
  assert.equal(a.framework.version, b.framework.version);
  assert.equal(a.oracle.script, b.oracle.script);
  for (const r of [a, b]) assert.ok(r.limits.some((l) => l.id === 'shared-run'));
});

test('versions, statuses and specificity quoted in prose are recorded pins, Node versions, range queries and oracle answers', () => {
  const VERSION = /(?<![\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?!\w|\.\d)/g;
  for (const { record: r } of loaded) {
    const known = new Set([...r.framework.packages.map((p) => p.version), ...r.runs.map((x) => x.node.replace(/^v/, '')), ...((r.framework.rangeQuery ?? '').match(/\d+\.\d+\.\d+/g) ?? [])]);
    const prose = JSON.stringify([r.claim.scope, r.claim.runtimeTested, r.supported, r.unsupported, r.mustCatch.map((m) => [m.construct, m.note]), r.oracle.kind, r.conformance.reason, r.conformance.method, r.limits, r.framework.unverifiedRanges]);
    for (const [, v] of prose.matchAll(VERSION)) assert.ok(known.has(v), `${r.item}: prose quotes ${v}, which is no recorded pin, Node version or range query`);
    const specificity = r.claim.scope.match(/specificity (\d+)/);
    if (specificity) assert.equal(Number(specificity[1]), r.claim.registration.specificity, r.item);
    const oracle = JSON.parse(fs.readFileSync(path.join(repoRoot, r.oracle.output), 'utf8'));
    for (const m of r.mustCatch) {
      const seen = m.truth.map((t) => oracle.scenarios.find((s) => s.id === t.scenario)?.probes.find((p) => `${p.method} ${p.route}` === t.route && (p.auth ?? 'token') === (t.auth ?? 'token'))?.status);
      for (const [code] of `${m.construct} ${m.note}`.matchAll(/(?<![\w.:\/-])[1-5]\d\d(?![\w.:\/-])/g)) assert.ok(seen.includes(Number(code)), `${r.item} ${m.id}: prose quotes status ${code}, the oracle answered ${seen}`);
    }
  }
});

const disk = (rel) => fs.readFileSync(path.join(repoRoot, rel));
const over = (rel, f) => (p) => (p === rel ? f(disk(p)) : disk(p));
const step = (r, id) => r.runs.find((x) => x.id === id);
const flip = (b) => Buffer.concat([b, Buffer.from('\n')]);
// [label, record, mutate(clone) -> optional read override, expected error, re-seal after the edit]
const CASES = [
  ['prose edit that is not re-sealed', TS, (r) => { r.claim.scope += ' (edited)'; }, /seal does not match/, false],
  ['verdict flipped, re-sealed', TS, (r) => { r.mustCatch.find((m) => m.expected === 'silent-miss').expected = 'caught'; }, /verdict is silent-miss, record says caught/],
  ['emitted routes edited, re-sealed', NX, (r) => { r.conformance.emitted.normal.pop(); }, /normal: scanner now emits/],
  ['registration restated falsely', NX, (r) => { r.claim.registration.verificationBasis = 'official'; }, /claim\.registration differs/],
  ['registration alone declared support', TS, (r) => { r.claim.registrationAloneIsSupport = true; }, /schema/],
  ['framework pin edited', TS, (r) => { r.framework.packages[0].version = '4.0.0'; }, /pin @types\/express: lock has/],
  ['fixture bytes changed', TS, (r) => over(`${r.fixtures.normal.dir}/${r.fixtures.normal.files[0].path}`, flip), /fixture normal .* drifted/],
  ['oracle output changed', NX, (r) => over(r.oracle.output, flip), /evidence\(oracle-output\) .* drifted/],
  ['lock file changed', NX, (r) => over(r.evidenceFiles.find((f) => f.role === 'lock').path, flip), /evidence\(lock\) .* drifted/],
  ['declared fixture file missing', TS, (r) => over(`${r.fixtures.normal.dir}/${r.fixtures.normal.files[0].path}`, () => { throw new Error('ENOENT'); }), /declared file .* is missing/],
  ['scanner module missing', TS, (r) => { r.scanner.module = 'adapters/does-not-exist/adapter.mjs'; }, /declared file adapters\/does-not-exist\/adapter\.mjs is missing/],
  ['unsafe path with a .. segment', TS, (r) => { r.evidenceFiles[0].path = '../outside.json'; }, /unsafe path/],
  ['unknown run id', TS, (r) => { r.runs[0].id = 'registry-bogus'; }, /unknown run id registry-bogus/],
  ['argv tokens reordered', TS, (r) => { const s = step(r, 'install-2'); [s.argv[2], s.argv[3]] = [s.argv[3], s.argv[2]]; s.command = s.argv.join(' '); }, /exact token order/],
  ['run input hash edited', NX, (r) => { step(r, 'install-2').inputsSha256 = '0'.repeat(64); }, /inputsSha256 does not match/],
  ['run output hash edited', TS, (r) => { step(r, 'oracle-1').output.sha256 = '0'.repeat(64); }, /run oracle-1 output .* drifted/],
  ['run exit code edited', TS, (r) => { step(r, 'oracle-1').exitCode = 1; }, /exit code|schema/],
  ['unknown schema key', NX, (r) => { r.extra = 1; }, /schema/],
  ['lock evidence entry dropped', TS, (r) => { r.evidenceFiles = r.evidenceFiles.filter((f) => f.role !== 'lock'); }, /schema \/evidenceFiles/],
  ['limit status flipped', NX, (r) => { r.limits.find((l) => l.id === 'promotion-held').status = 'UNKNOWN'; }, /the registered status is BLOCKED/],
  ['unregistered limit id', NX, (r) => { r.limits.push({ id: 'made-up', status: 'UNKNOWN', text: 'a limit id that is not registered' }); }, /unknown limit id/],
  ['environment policy changed', TS, (r) => { r.runEnv.variables.PATH = '/usr/local/bin:/usr/bin:/bin'; }, /runEnv\.variables differ/],
  ['required must-catch category dropped', NX, (r) => { r.mustCatch = r.mustCatch.filter((m) => m.category !== 'generated-routes'); }, /mustCatch lacks category generated-routes/],
  ['BLOCKED check expectation edited', FY, (r) => { r.conformance.checks[0].expect = 'tampered'; }, /blocked check/],
  ['BLOCKED record claims a scanner verdict', FY, (r) => { r.mustCatch[0].expected = 'caught'; }, /BLOCKED conformance cannot carry scanner verdicts/],
];
for (const [label, item, mutate, expected, reseal = true] of CASES) {
  test(`tamper is reported: ${label}`, async () => {
    const clone = structuredClone(byItem[item]);
    const read = mutate(clone);
    if (reseal) clone.seal.sha256 = sealOf(clone);
    const errors = await verifyRecord(clone, typeof read === 'function' ? { read } : undefined);
    assert.ok(errors.some((e) => expected.test(e)), `expected an error matching ${expected}; got ${JSON.stringify(errors.slice(0, 4))}`);
  });
}
