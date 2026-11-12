import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REL = 'adapters/http/csharp-aspnet-core/SCOPE_EVIDENCE.json';
const SHA = /^[0-9a-f]{40}$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (args) => execFileSync('git', args, {
  cwd: ROOT, encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative));

export const UPSTREAM = Object.freeze({
  repo: 'dotnet/AspNetCore.Docs',
  path: 'aspnetcore/tutorials/min-web-api/samples/8.x/todoDTO',
  commit: '5f20cce1736b24cb468c98833d965e969613bc3f',
  framework: 'net8.0 sample',
  comparison: 'BLOCKED_INFRA',
  reason: 'No dotnet/Roslyn execution or pinned upstream checkout was acquired by this bounded local run.',
});

export const SCOPE = Object.freeze({
  oracle: 'T08 csharp-static-pilot facts projected by the existing T12 ASP.NET Core leaf',
  framework_range: 'net8.0 sample source shape only; no SDK, package, or runtime range claimed',
  dotnet_executed: false,
  roslyn_executed: false,
  kestrel_executed: false,
});

export const SOURCE_FILES = Object.freeze([
  'adapters/http/csharp-aspnet-core/TARGET_SCOPE.md',
  'adapters/http/csharp-aspnet-core/fixtures/negative/DynamicRoutes.cs',
  'adapters/http/csharp-aspnet-core/fixtures/positive/Program.cs',
  'adapters/http/csharp-aspnet-core/fixtures/positive/TodoController.cs',
  'adapters/http/csharp-aspnet-core/scope-evidence.mjs',
  'adapters/http/csharp-aspnet-core/scope-evidence.test.mjs',
  'adapters/http/csharp-aspnet-core/target-scope-negative.test.mjs',
  'adapters/http/csharp-aspnet-core/target-scope.test.mjs',
  'adapters/http-wave-a/_shared.mjs',
  'adapters/http-wave-a/aspnet-core.mjs',
  'scanners/language/native-server/csharp.mjs',
  'scanners/language/native-server/shared.mjs',
  'next/t00/baseline.lock.json',
  'next/t00/build-ownership-map.mjs',
  'next/t00/check-ownership.mjs',
  'next/t00/fixtures/ownership-rules.json',
  'next/t00/fixtures/plan-write-scopes.json',
  'next/t00/ownership-map.json',
  'next/t00/ownership.mjs',
  'next/t00/snapshot-plan.mjs',
  'next/t00/verify-baseline.mjs',
  'scripts/run-next-nested-tests.mjs',
]);

export const COMMAND = Object.freeze([
  'node', '--test',
  'adapters/http/csharp-aspnet-core/target-scope.test.mjs',
  'adapters/http/csharp-aspnet-core/target-scope-negative.test.mjs',
]);
export const RECEIPT = path.join(ROOT, REL);
export const digests = () => Object.fromEntries(SOURCE_FILES.map((relative) => [relative, hash(read(relative))]));

export function replay() {
  const env = { ...process.env, NODE_OPTIONS: '' };
  for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST_')) delete env[key];
  const result = spawnSync(process.execPath, COMMAND.slice(1), {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env,
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error('direct scope tests did not pass: ' + String(result.stderr ?? '').slice(-500));
  }
  const output = String(result.stdout ?? '') + '\n' + String(result.stderr ?? '');
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']) {
    const matches = [...output.matchAll(new RegExp('(?:^|\\n)(?:#|ℹ)\\s*' + key + '\\s+(\\d+)', 'g'))];
    if (!matches.length) throw new Error('missing TAP ' + key);
    counts[key] = Number(matches.at(-1)[1]);
  }
  if (counts.tests !== 14 || counts.pass !== 14 || counts.fail || counts.skipped || counts.cancelled || counts.todo) {
    throw new Error('not 14/14 zero-skip ' + JSON.stringify(counts));
  }
  return { command: COMMAND, exit_code: 0, counts };
}

const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort());

export function problems(receipt, actual = digests(), gitCheck = true) {
  const bad = [];
  if (!exactKeys(receipt, ['schema', 'task', 'source_commit', 'upstream', 'scope', 'sources', 'observed', 'assertions', 'limits'])) {
    return ['invalid receipt field set'];
  }
  if (!exactKeys(receipt.sources, SOURCE_FILES)) return ['invalid source map'];
  if (!exactKeys(receipt.upstream, ['repo', 'path', 'commit', 'framework', 'comparison', 'reason'])) bad.push('invalid upstream field set');
  if (!exactKeys(receipt.scope, ['oracle', 'framework_range', 'dotnet_executed', 'roslyn_executed', 'kestrel_executed'])) bad.push('invalid scope field set');
  if (!exactKeys(receipt.assertions, ['MET', 'release', 'runtime_certified', 'external_runtime_equal', 'signed_attestation'])) bad.push('invalid authority field set');
  if (!exactKeys(receipt.observed, ['command', 'exit_code', 'counts'])) bad.push('invalid replay field set');
  if (!exactKeys(receipt.observed?.counts, ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'])) bad.push('invalid TAP field set');
  if (receipt.schema !== 'bskel.aspnet-target-scope-proof/1' || receipt.task !== 'HTTP-csharp-aspnet-core-01') bad.push('identity');
  if (!SHA.test(receipt.source_commit ?? '')) bad.push('source commit invalid');
  if (JSON.stringify(receipt.upstream) !== JSON.stringify(UPSTREAM)) bad.push('upstream identity or comparison drift');
  if (JSON.stringify(receipt.scope) !== JSON.stringify(SCOPE)) bad.push('oracle/runtime scope drift');
  for (const relative of SOURCE_FILES) {
    if (!/^[0-9a-f]{64}$/.test(receipt.sources[relative] ?? '') || receipt.sources[relative] !== actual[relative]) {
      bad.push('source digest drift ' + relative);
    }
  }
  const authority = receipt.assertions ?? {};
  if (authority.MET !== 0 || authority.release !== false || authority.runtime_certified !== false
      || authority.external_runtime_equal !== false || authority.signed_attestation !== false) {
    bad.push('false authority');
  }
  if (JSON.stringify(receipt.observed) !== JSON.stringify(replay())) bad.push('replay mismatch');
  if (!String(receipt.limits).includes('BLOCKED_INFRA') || !String(receipt.limits).includes('not runtime certified')) bad.push('scope limit');

  if (gitCheck && SHA.test(receipt.source_commit ?? '')) {
    try {
      if (git(['cat-file', '-t', receipt.source_commit]) !== 'commit') bad.push('missing original commit');
      const existed = spawnSync('git', ['cat-file', '-e', receipt.source_commit + ':' + REL], { cwd: ROOT });
      if (existed.status === 0) bad.push('receipt already in original commit');
      const delta = git(['diff', '--name-only', receipt.source_commit, 'HEAD', '--', ...SOURCE_FILES, REL]);
      if (delta.split('\n').filter(Boolean).some((relative) => relative !== REL)) bad.push('original sources changed');
      for (const relative of SOURCE_FILES) {
        const blob = execFileSync('git', ['show', receipt.source_commit + ':' + relative], { cwd: ROOT, timeout: 12_000 });
        if (hash(blob) !== receipt.sources[relative]) bad.push('original Git blob differs ' + relative);
      }
    } catch (error) {
      bad.push('original Git evidence unavailable ' + error.message);
    }
  }
  return bad;
}

const mode = process.argv[2];
if (mode === '--write' || mode === '--check') {
  try {
    if (mode === '--write') {
      const receipt = {
        schema: 'bskel.aspnet-target-scope-proof/1',
        task: 'HTTP-csharp-aspnet-core-01',
        source_commit: git(['rev-parse', 'HEAD']),
        upstream: UPSTREAM,
        scope: SCOPE,
        sources: digests(),
        observed: replay(),
        assertions: {
          MET: 0, release: false, runtime_certified: false,
          external_runtime_equal: false, signed_attestation: false,
        },
        limits: 'Static source-shape evidence only; BLOCKED_INFRA for pinned upstream and dotnet/Roslyn/Kestrel execution; not runtime certified and no external equality, MET, release, or attestation authority.',
      };
      const failures = problems(receipt);
      if (failures.length) throw new Error(failures.join('; '));
      fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
      console.log('SCOPE_RECEIPT_WRITTEN');
    } else {
      const failures = problems(JSON.parse(fs.readFileSync(RECEIPT, 'utf8')));
      if (failures.length) throw new Error(failures.join('; '));
      console.log('SCOPE_EVIDENCE_PASS source-bound real 14/14, MET=0, BLOCKED_INFRA');
    }
  } catch (error) {
    console.error('SCOPE_EVIDENCE_FAIL ' + error.message);
    process.exitCode = 1;
  }
}
