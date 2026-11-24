import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT, loadRecord, recordDir, sealRecord, verifyScopeRecord, expectedCommands,
  compareLayer, derivePartition, outcomeOf } from '../../adapters/http-wave-a/python-scope/verify.mjs';
import { runStatic, serializeStatic, STATIC_LAYER_SOURCES } from '../../adapters/http-wave-a/python-scope/static-runner.mjs';

const STARLETTE_LAYER = 't13-starlette-static';
const STARLETTE_SOURCES = ['facts.py', 'project.mjs', 'scan.mjs']
  .map(member => path.posix.join(path.posix.dirname(STATIC_LAYER_SOURCES[STARLETTE_LAYER]), member));
const item = 'HTTP-python-starlette-01';
const sha = x => createHash('sha256').update(x).digest('hex');
const data = (p, value) => fs.writeFileSync(p, value);
const codes = p => p.map(x => x.code);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't12-forward-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = recordDir(item, root);
  fs.cpSync(recordDir(item, REPO_ROOT), dir, { recursive: true });
  const r = loadRecord(item, root);
  const oracle = path.join(root, r.oracle_tool.path);
  fs.mkdirSync(path.dirname(oracle), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, r.oracle_tool.path), oracle);
  return { root, dir, r };
}

function declared(t) {
  const { root, dir, r } = fixture(t);
  fs.mkdirSync(path.join(root, path.dirname(STARLETTE_SOURCES[0])), { recursive: true });
  const marker = path.join(root, 'scanner-ran');
  // A test double for the future scanner contract, not proof of a shipped adapter.
  const inputs = ['# test member\n', 'export {};\n',
    'import { writeFileSync } from "node:fs"; export function scanStarletteScopeLayer() { writeFileSync(' +
    JSON.stringify(marker) + ', "ran"); return {routes: [], flags: []}; }\n'];
  r.starlette_static_sources = Object.fromEntries(STARLETTE_SOURCES.map((name, i) => {
    data(path.join(root, name), inputs[i]);
    return [name, sha(inputs[i])];
  }));
  r.layers = [{ id: STARLETTE_LAYER, source: STARLETTE_SOURCES[2], role: 'test-only adapter contract' }];
  r.claims.extraction = 'partial-static';
  r.claims.statement = 'Test-only contract. No runtime or support claim.';
  r.evidence_level = 'oracle-compared';
  r.conformance = { status: 'COMPARED', layers: [STARLETTE_LAYER], compared_fixtures: r.fixtures.length };
  for (const mc of r.must_catch) {
    const compared = compareLayer(mc.expected, []);
    mc.layers[STARLETTE_LAYER] = { ...compared, outcome: outcomeOf(mc.rule, compared, false), flags: [], covering_flags: [] };
  }
  r.scope = derivePartition(r);
  const result = serializeStatic(runStatic('starlette', path.join(dir, 'fixtures'), { repoRoot: root }));
  fs.rmSync(marker);
  data(path.join(dir, 'results/static.json'), result);
  for (const entry of expectedCommands(r).slice(-3)) {
    r.executed_commands.push({ id: entry.id, command: entry.command, exit_code: 0,
      stored_as: entry.file, stdout_sha256: sha(result), stdout_bytes: Buffer.byteLength(result) });
  }
  return { root, dir, r, marker };
}

test('T12 Starlette scope-only works without adapter; partial appearance does not opt in', t => {
  const f = fixture(t);
  assert.deepEqual(verifyScopeRecord(f.r, f), []);
  const target = path.join(f.root, STARLETTE_SOURCES[0]);
  fs.mkdirSync(path.dirname(target), { recursive: true }); data(target, '# not yet installed');
  assert(codes(verifyScopeRecord(f.r, f)).includes('adapter-appeared'));
});
test('T12 accepts the complete static contract and does not make runtime claims', t => {
  const f = declared(t);
  assert.deepEqual(verifyScopeRecord(sealRecord(f.r), f), []);
  assert(fs.existsSync(f.marker));
  assert.equal(f.r.runtime_tested.status, 'BLOCKED');
  assert.equal(f.r.claims.supported, false);
});
for (const [label, change, want] of [
  ['missing manifest field', f => { delete f.r.starlette_static_sources; }, 'starlette-binding'],
  ['partial manifest', f => { delete f.r.starlette_static_sources[STARLETTE_SOURCES[0]]; }, 'schema'],
  ['missing implementation member', f => fs.rmSync(path.join(f.root, STARLETTE_SOURCES[0])), 'starlette-binding'],
  ['changed implementation member', f => fs.appendFileSync(path.join(f.root, STARLETTE_SOURCES[1]), '\n'), 'starlette-binding'],
  ['changed fixture bytes', f => fs.appendFileSync(path.join(f.dir, 'fixtures/normal/app.py'), '\n'), 'fixture-hash'],
  ['wrong registration', f => { f.r.registration.entry.id = 'python-litestar'; }, 'registration'],
  ['missing replay output', f => fs.rmSync(path.join(f.dir, 'results/static.json')), 'result-set'],
  ['unbound replay output', f => fs.appendFileSync(path.join(f.dir, 'results/static.json'), '\n'), 'result-hash'],
]) test('T12 declared Starlette rejects ' + label + ' before replay', t => {
  const f = declared(t); change(f);
  const problems = verifyScopeRecord(sealRecord(f.r), f);
  assert(codes(problems).includes(want), JSON.stringify(problems));
  assert(!fs.existsSync(f.marker));
});
