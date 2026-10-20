import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { spawnSync } from 'node:child_process';
import * as producer from '../scripts/t22-distribution-report.mjs';
import {
  T22_DISTRIBUTION_RECEIPT,
  canonicalJson,
  receiptBytes,
  sha256Bytes,
  verifyDistributionArtifacts as verifyDistributionArtifactsRaw,
} from '../scripts/t22-distribution-receipt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = '1'.repeat(40);
const TREE = '2'.repeat(40);
const SOURCE_FILES = [
 { path: 'package-lock.json', size_bytes: 1, sha256: 'a'.repeat(64) },
 { path: 'sdk/next/index.mjs', size_bytes: 123, sha256: 'b'.repeat(64) },
];
const EXPECTED_MEMBERS = [{path:'sdk/next/index.mjs',size_bytes:123,mode:420}];
function verifyDistributionArtifacts(directory, options = {}) {
  return verifyDistributionArtifactsRaw(directory, { expectedHead: HEAD, expectedTree: TREE, expectedNodeExecutable: process.execPath, expectedNpmExecutable: '/trusted/npm/bin/npm-cli.js', expectedNpmExecutableSha256: 'c'.repeat(64), expectedSourceInventory: SOURCE_FILES, expectedMemberInventory: EXPECTED_MEMBERS, expectedTarballSha256: sha256Bytes(Buffer.from('exact packed artifact')), ...options });
}


function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t22-receipt-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'durable');
  const scratch = path.join(parent, 'scratch');
  fs.mkdirSync(directory);
  fs.mkdirSync(scratch);
  const tarball = Buffer.from('exact packed artifact');
  const transcript = Buffer.from('TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  fs.writeFileSync(path.join(directory, 'candidate.tgz'), tarball);
  fs.writeFileSync(path.join(directory, 'test.tap'), transcript);
  fs.writeFileSync(path.join(directory, 'test.stderr'), '');
  fs.writeFileSync(path.join(directory,'cache-probe.stdout'),'');
  fs.writeFileSync(path.join(directory,'cache-probe.stderr'),'npm error code ENOTCACHED\n');
  const members = [{ path: 'sdk/next/index.mjs', size_bytes: 123, mode: 420 }];
  const receipt = {
    schema: T22_DISTRIBUTION_RECEIPT,
    status: 'pass',
    generated_at: '2026-10-19T00:00:00.000Z',
    environment: { npm_executable: '/trusted/npm/bin/npm-cli.js', npm_executable_sha256: 'c'.repeat(64), npm_command: [process.execPath, '/trusted/npm/bin/npm-cli.js'] },
    source: {
      head: HEAD, tree: TREE, expected_head: HEAD, dirty: false,
      materialization: { kind: 'git-archive', head: HEAD, tree: TREE },
      relevant_files: SOURCE_FILES.map((file) => ({ ...file })),
    },
    package: {
      tarball_file: 'candidate.tgz', tarball_sha256: sha256Bytes(tarball),
      tarball_size_bytes: tarball.byteLength, member_count: members.length,
      member_inventory_sha256: sha256Bytes(Buffer.from(canonicalJson(members))), members,
    },
    test: {
      command: [process.execPath, '--test', '--test-reporter=tap',
        'test/t22-packed-consumer.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs'],
      error: null, signal: null, exit_code: 0, counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
      transcript_file: 'test.tap', transcript_sha256: sha256Bytes(transcript),
      stderr_file: 'test.stderr', stderr_sha256: sha256Bytes(Buffer.from('')),
      tarball_sha256: sha256Bytes(tarball),
    },
    cache: {
      mode: 'network-disabled-prewarmed-npm-cache', lockfile_sha256: 'a'.repeat(64),
      empty_cache_probe_expected: 'nonzero-exit', empty_cache_probe_exit_code: 1,
      empty_cache_probe_signal: null, empty_cache_probe_error: null,
      empty_cache_probe_stdout_file: 'cache-probe.stdout', empty_cache_probe_stdout_sha256: sha256Bytes(Buffer.from('')),
      empty_cache_probe_stderr_file: 'cache-probe.stderr', empty_cache_probe_stderr_sha256: sha256Bytes(Buffer.from('npm error code ENOTCACHED\n')),
    },
    failures: [],
  };
  const bytes = receiptBytes(receipt);
  fs.writeFileSync(path.join(directory, 'receipt.json'), bytes);
  fs.writeFileSync(path.join(directory, 'receipt.sha256'), `${sha256Bytes(bytes)}\n`);
  return { directory, scratch, receipt };
}

test('T22R01 detached receipt verifies and survives deletion of unrelated scratch', (t) => {
  const { directory, scratch } = fixture(t);
  fs.rmSync(scratch, { recursive: true, force: true });
  const verified = verifyDistributionArtifacts(directory, { expectedHead: HEAD });
  assert.deepEqual(verified.problems, []);
  assert.match(verified.receiptSha256, /^[0-9a-f]{64}$/);
});

test('T22R02 expected source HEAD mismatch fails closed', (t) => {
  const { directory } = fixture(t);
  const verified = verifyDistributionArtifacts(directory, { expectedHead: 'f'.repeat(40) });
  assert.match(verified.problems.join('\n'), /source HEAD mismatch/);
});

test('T22R03 preserved tarball mutation and external digest mismatch fail closed', (t) => {
  const { directory, receipt } = fixture(t);
  fs.appendFileSync(path.join(directory, 'candidate.tgz'), 'mutated');
  const verified = verifyDistributionArtifacts(directory, {
    expectedHead: HEAD, expectedTarballSha256: receipt.package.tarball_sha256,
  });
  assert.match(verified.problems.join('\n'), /tarball SHA-256 does not match receipt/);
  assert.match(verifyDistributionArtifacts(directory, {
    expectedHead: HEAD, expectedTarballSha256: '0'.repeat(64),
  }).problems.join('\n'), /tarball SHA-256 mismatch/);
});

test('T22R04 changed receipt bytes invalidate the detached SHA-256', (t) => {
  const { directory, receipt } = fixture(t);
  fs.appendFileSync(path.join(directory, 'receipt.json'), ' ');
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),
    /detached receipt SHA-256 does not match/);
});

test('T22R05 offline mode is explicitly warm-cache and empty-cache-negative', (t) => {
  const { directory } = fixture(t);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8'));
  receipt.cache.mode = 'hermetic-single-tarball';
  receipt.cache.empty_cache_probe_exit_code = 0;
  const bytes = receiptBytes(receipt);
  fs.writeFileSync(path.join(directory, 'receipt.json'), bytes);
  fs.writeFileSync(path.join(directory, 'receipt.sha256'), `${sha256Bytes(bytes)}\n`);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /pre-warmed offline precondition/);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /empty-cache offline negative/);
});

test('T22R06 package script and regular CI preserve the durable report', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:t22-distribution'], 'node scripts/t22-distribution-report.mjs');
  const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow.jobs['nested-next'].steps;
  const report = steps.find((step) => step.name === 'T22 durable distribution report');
  assert.match(report?.run ?? '', /npm run test:t22-distribution/);
  assert.match(report?.run ?? '', /git rev-parse HEAD/);
  const upload = steps.find((step) => step.name === 'Upload T22 durable distribution report');
  assert.equal(upload?.uses, 'actions/upload-artifact@v4');
  assert.equal(upload?.if, 'always()');
  assert.equal(upload?.with?.['if-no-files-found'], 'error');
});

// An empty or contradictory test receipt must not count as product evidence.
function rewriteFixtureReceipt(directory, receipt) {
  const bytes = receiptBytes(receipt);
  fs.writeFileSync(path.join(directory, 'receipt.json'), bytes);
  fs.writeFileSync(path.join(directory, 'receipt.sha256'), `${sha256Bytes(bytes)}\n`);
}
function replaceTap(directory, receipt, counts) {
  const transcript = Buffer.from(`TAP version 13\n1..${counts.tests}\n` +
    Object.entries(counts).map(([key, value]) => `# ${key} ${value}\n`).join(''));
  fs.writeFileSync(path.join(directory, 'test.tap'), transcript);
  receipt.test.transcript_sha256 = sha256Bytes(transcript);
}

test('T22R07 zero executed tests cannot produce an accepted passing receipt', (t) => {
  const { directory, receipt } = fixture(t);
  receipt.test.counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  replaceTap(directory, receipt, receipt.test.counts);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /executed passing test/);
});

test('T22R08 an all-skipped suite cannot count as product acceptance', (t) => {
  const { directory, receipt } = fixture(t);
  receipt.test.counts = { tests: 1, pass: 0, fail: 0, cancelled: 0, skipped: 1, todo: 0 };
  replaceTap(directory, receipt, receipt.test.counts);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /executed passing test/);
});

test('T22R09 passing metadata cannot contradict the retained TAP summary', (t) => {
  const { directory, receipt } = fixture(t);
  replaceTap(directory, receipt, { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /TAP summary.*(pass|fail)/);
});

test('T22R10 a transcript without a complete TAP summary fails closed', (t) => {
  const { directory, receipt } = fixture(t);
  const transcript = Buffer.from('TAP version 13\n1..1\n# pass 1\n');
  fs.writeFileSync(path.join(directory, 'test.tap'), transcript);
  receipt.test.transcript_sha256 = sha256Bytes(transcript);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /TAP summary/);
});

test('T22R11 duplicate TAP count lines cannot be accepted as one run', (t) => {
  const { directory, receipt } = fixture(t);
  fs.appendFileSync(path.join(directory, 'test.tap'), '# pass 1\n');
  receipt.test.transcript_sha256 = sha256Bytes(fs.readFileSync(path.join(directory, 'test.tap')));
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /TAP summary/);
});


for (const [label, counts] of [
  ['pass exceeds tests', { tests: 1, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 }],
  ['outcomes undercount tests', { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 }],
  ['overlapping pass and skipped', { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 }],
  ['unsafe summed outcome count', { tests: Number.MAX_SAFE_INTEGER, pass: Number.MAX_SAFE_INTEGER,
    fail: 0, cancelled: 0, skipped: 1, todo: 0 }],
]) {
  test(`T22R12 inconsistent totals fail closed: ${label}`, (t) => {
    const { directory, receipt } = fixture(t);
    receipt.test.counts = counts;
    replaceTap(directory, receipt, counts);
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /outcome counts.*total/);
  });
}

test('T22R13 valid passing tests with an explicit skip retain consistent totals', (t) => {
  const { directory, receipt } = fixture(t);
  receipt.test.counts = { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 };
  replaceTap(directory, receipt, receipt.test.counts);
  rewriteFixtureReceipt(directory, receipt);
  assert.deepEqual(verifyDistributionArtifacts(directory).problems, []);
});


for (const failures of [['HARNESS_ERROR retained failure'], null, 'not-an-array']) {
  test(`T22R14 contradictory or malformed failure inventory is rejected: ${JSON.stringify(failures)}`, (t) => {
    const { directory, receipt } = fixture(t); receipt.failures = failures;
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /failures/);
  });
}

for (const mode of ['missing', 'modified', 'symlink']) {
  test(`T22R15 retained stderr must remain exact and regular: ${mode}`, (t) => {
    const { directory } = fixture(t); const p = path.join(directory, 'test.stderr');
    if (mode === 'missing') fs.unlinkSync(p);
    if (mode === 'modified') fs.writeFileSync(p, 'changed diagnostics');
    if (mode === 'symlink') { fs.renameSync(p, path.join(directory, 'outside.stderr'));
      fs.symlinkSync('outside.stderr', p); }
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /stderr|regular/);
  });
}

for (const mode of ['mismatch', 'duplicate', 'invalid-digest']) {
  test(`T22R16 source and cache bind one exact lockfile: ${mode}`, (t) => {
    const { directory, receipt } = fixture(t);
    if (mode === 'mismatch') receipt.cache.lockfile_sha256 = 'b'.repeat(64);
    if (mode === 'duplicate') receipt.source.relevant_files.push({ ...receipt.source.relevant_files[0] });
    if (mode === 'invalid-digest') receipt.source.relevant_files[0].sha256 = 'invalid';
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /lockfile/);
  });
}

test('T22R17 source expected_head cannot contradict a passing source head', (t) => {
  const { directory, receipt } = fixture(t); receipt.source.expected_head = 'f'.repeat(40);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /expected_head/);
});

test('T22R18 JSON null is a malformed receipt, not empty successful verification', (t) => {
  const { directory } = fixture(t); rewriteFixtureReceipt(directory, null);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /receipt.*object/);
});


test('T22R19 externally bound HEAD also requires its exact trusted Git tree', (t) => {
  const { directory, receipt } = fixture(t); receipt.source.tree = 'f'.repeat(40);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /source tree mismatch/);
});

for (const options of [{}, { expectedHead: HEAD }, { expectedHead: HEAD, expectedTree: 'invalid' }, { expectedTree: TREE }]) {
  test(`T22R20 pass acceptance requires externally supplied commit and tree: ${JSON.stringify(options)}`, (t) => {
    const { directory } = fixture(t);
    assert.match(verifyDistributionArtifactsRaw(directory, options).problems.join('\n'), /expectedHead|expectedTree/);
  });
}


for (const [label, command] of [
  ['missing', undefined], ['unrelated program', ['true']],
  ['unrelated absolute program', ['/bin/true', '--test', '--test-reporter=tap',
    'test/t22-packed-consumer.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs']],
  ['missing required suite', [process.execPath, '--test', '--test-reporter=tap', 'test/t22-packed-consumer.test.mjs']],
  ['different test', [process.execPath, '--test', '--test-reporter=tap', 'test/unrelated.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs']],
  ['injected node flag', [process.execPath, '--require', 'inject.mjs', '--test', '--test-reporter=tap',
    'test/t22-packed-consumer.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs']],
  ['wrong reporter', [process.execPath, '--test', '--test-reporter=spec',
    'test/t22-packed-consumer.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs']],
]) {
  test(`T22R21 required distribution command is bound: ${label}`, (t) => {
    const { directory, receipt } = fixture(t); receipt.test.command = command;
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /required distribution test command/);
  });
}


for (const signal of ['SIGKILL', 'SIGTERM', undefined, '', false, 0]) {
  test(`T22R22 passing execution requires an explicit null signal: ${String(signal)}`, (t) => {
    const { directory, receipt } = fixture(t); receipt.test.signal = signal;
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /signal|failing test outcome/);
  });
}


function failureFixture(t) {
 const f = fixture(t); f.receipt.status = 'fail'; f.receipt.failures = ['TEST_EXIT_1'];
 f.receipt.test.exit_code = 1;
 f.receipt.test.counts = {tests:1,pass:0,fail:1,cancelled:0,skipped:0,todo:0};
 replaceTap(f.directory, f.receipt, f.receipt.test.counts);
 rewriteFixtureReceipt(f.directory, f.receipt); return f;
}
test('T22R23 valid recorded failure preserves verifiable diagnostics without becoming pass', (t) => {
 const { directory } = failureFixture(t); const v = verifyDistributionArtifacts(directory);
 assert.deepEqual(v.problems, []); assert.equal(v.receipt.status, 'fail');
});
for (const file of ['candidate.tgz','test.tap','test.stderr']) {
 for (const kind of ['missing','altered']) {
  test(`T22R24 failure diagnostics are checked: ${file} ${kind}`, (t) => {
   const { directory } = failureFixture(t);
   if (kind === 'missing') fs.unlinkSync(path.join(directory,file));
   else fs.appendFileSync(path.join(directory,file),'corrupted');
   assert.notEqual(verifyDistributionArtifacts(directory).problems.length,0);
  });
 }
}
test('T22R25 a failure before artifact creation stays a verifiable failure record', (t) => {
 const {directory,receipt}=fixture(t); receipt.status='fail';receipt.failures=['EARLY_FAILURE'];
 receipt.package=null;receipt.test=null;
 for (const file of ['candidate.tgz','test.tap','test.stderr']) fs.unlinkSync(path.join(directory,file));
 rewriteFixtureReceipt(directory,receipt);
 assert.deepEqual(verifyDistributionArtifacts(directory).problems,[]);
});
for (const node of ['/tmp/node','/different/node',undefined]) {
 test(`T22R26 exact independently supplied executable is required: ${String(node)}`, (t) => {
  const {directory,receipt}=fixture(t);
  if (node !== undefined) receipt.test.command[0]=node;
  rewriteFixtureReceipt(directory,receipt);
  const options=node===undefined ? {expectedNodeExecutable:undefined} : {};
  assert.match(verifyDistributionArtifacts(directory,options).problems.join('\n'),/expectedNodeExecutable|executable/);
 });
}
for (const kind of ['missing-entry','extra-entry','wrong-path','wrong-size','wrong-hash','duplicate','unsafe-path','null-entry']) {
 test(`T22R27 complete expected source inventory is checked: ${kind}`, (t) => {
  const {directory,receipt}=fixture(t);const a=receipt.source.relevant_files;
  if(kind==='missing-entry')a.pop();
  if(kind==='extra-entry')a.push({path:'made-up.mjs',size_bytes:1,sha256:'c'.repeat(64)});
  if(kind==='wrong-path')a[1].path='nonexistent.mjs';
  if(kind==='wrong-size')a[1].size_bytes=999;
  if(kind==='wrong-hash')a[1].sha256='c'.repeat(64);
  if(kind==='duplicate')a.push({...a[1]});
  if(kind==='unsafe-path')a[1].path='../outside';
  if(kind==='null-entry')a.push(null);
  rewriteFixtureReceipt(directory,receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),/source inventory/);
 });
}
test('T22R28 pass acceptance without external source inventory fails closed', (t) => {
 const {directory}=fixture(t);
 assert.match(verifyDistributionArtifacts(directory,{expectedSourceInventory:undefined}).problems.join('\n'),/expectedSourceInventory|source inventory/);
});


for (const kind of ['path','size','mode','missing','duplicate']) {
 test(`T22R29 member inventory must match independently captured pack metadata: ${kind}`, (t) => {
  const {directory,receipt}=fixture(t);const a=receipt.package.members;
  if(kind==='path')a[0].path='fake.mjs';if(kind==='size')a[0].size_bytes=999;
  if(kind==='mode')a[0].mode=493;if(kind==='missing')a.pop();if(kind==='duplicate')a.push({...a[0]});
  receipt.package.member_count=a.length;receipt.package.member_inventory_sha256=sha256Bytes(Buffer.from(canonicalJson(a)));
  rewriteFixtureReceipt(directory,receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),/member inventory/);
 });
}
for (const options of [{expectedMemberInventory:undefined},{expectedTarballSha256:undefined}]) {
 test(`T22R30 package verification requires independent expectations: ${Object.keys(options)}`, (t) => {
  const {directory}=fixture(t);
  assert.match(verifyDistributionArtifacts(directory,options).problems.join('\n'),/expectedMemberInventory|expectedTarballSha256/);
 });
}
test('T22R31 a failure after packing retains a verifiable package without pretending tests ran', (t) => {
 const {directory,receipt}=fixture(t);receipt.status='fail';receipt.failures=['SPAWN_ERROR'];receipt.test=null;
 fs.unlinkSync(path.join(directory,'test.tap'));fs.unlinkSync(path.join(directory,'test.stderr'));
 rewriteFixtureReceipt(directory,receipt);const result=verifyDistributionArtifacts(directory);
 assert.deepEqual(result.problems,[]);assert.equal(result.receipt.test,null);
});
test('T22R32 unrecorded durable artifacts cannot be accepted as an early failure', (t) => {
 const {directory,receipt}=fixture(t);receipt.status='fail';receipt.failures=['EARLY'];receipt.package=null;receipt.test=null;
 rewriteFixtureReceipt(directory,receipt);
 assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),/unrecorded artifact/);
});
for (const file of ['cache-probe.stdout','cache-probe.stderr']) {
 test(`T22R33 retained dependency-probe diagnostics are verified: ${file}`, (t) => {
  const {directory}=fixture(t);fs.appendFileSync(path.join(directory,file),'changed');
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),/cache.*SHA/);
 });
}
test('T22R34 unrelated offline probe failure is not dependency-cache proof', (t) => {
 const {directory,receipt}=fixture(t);const b=Buffer.from('npm error invalid configuration');
 fs.writeFileSync(path.join(directory,'cache-probe.stderr'),b);receipt.cache.empty_cache_probe_stderr_sha256=sha256Bytes(b);
 rewriteFixtureReceipt(directory,receipt);
 assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),/ENOTCACHED/);
});
test('T22R35 test spawn errors cannot coexist with a passing outcome', (t) => {
 const {directory,receipt}=fixture(t);receipt.test.error='ETIMEDOUT';rewriteFixtureReceipt(directory,receipt);
 assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),/failing test outcome/);
});

for (const change of ['path','hash','command','missing-expectation']) {
 test(`T22R36 npm execution identity must match independent expectations: ${change}`,(t)=>{
  const {directory,receipt}=fixture(t);const options={};
  if(change==='path')receipt.environment.npm_executable='/untrusted/npm/bin/npm-cli.js';
  if(change==='hash')receipt.environment.npm_executable_sha256='d'.repeat(64);
  if(change==='command')receipt.environment.npm_command=['/bin/true'];
  if(change==='missing-expectation')options.expectedNpmExecutable=undefined;
  rewriteFixtureReceipt(directory,receipt);
  assert.match(verifyDistributionArtifacts(directory,options).problems.join('\n'),/npm|Npm/);
 });
}
test('T22R37 evidence resolver rejects the test npm override without execution',()=>{
 assert.equal(typeof producer.resolveNpmInvocation,'function');
 assert.throws(()=>producer.resolveNpmInvocation({...process.env,T22_TEST_NPM:'/bin/true'}),/NPM_OVERRIDE/);
 assert.throws(()=>producer.resolveNpmInvocation({...process.env,T22_TEST_NPM:''}),/NPM_OVERRIDE/);
});
test('T22R38 pinned source materialization ignores modified and untracked checkout bytes',(t)=>{
 assert.equal(typeof producer.materializePinnedSource,'function');
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'t22-source-pin-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const repo=path.join(parent,'repo');fs.mkdirSync(repo);
 const git=(...args)=>{const p=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
 git('init','-q');fs.writeFileSync(path.join(repo,'source.txt'),'original');git('add','.');
 git('-c','user.name=T22 test','-c','user.email=t22@example.invalid','commit','-qm','fixture');const head=git('rev-parse','HEAD');
 fs.writeFileSync(path.join(repo,'source.txt'),'mutated!');fs.writeFileSync(path.join(repo,'untracked.txt'),'not-pinned');
 const dest=path.join(parent,'snapshot');producer.materializePinnedSource(repo,head,dest,[{path:'source.txt',size_bytes:8,sha256:sha256Bytes(Buffer.from('original'))}]);
 assert.equal(fs.readFileSync(path.join(dest,'source.txt'),'utf8'),'original');assert.equal(fs.existsSync(path.join(dest,'untracked.txt')),false);
 assert.equal(fs.readFileSync(path.join(repo,'source.txt'),'utf8'),'mutated!');
});
for (const field of ['kind','head','tree']) {
 test(`T22R39 source snapshot identity is bound: ${field}`,(t)=>{
  const {directory,receipt}=fixture(t);receipt.source.materialization[field]='wrong';rewriteFixtureReceipt(directory,receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),/materialization/);
 });
}
