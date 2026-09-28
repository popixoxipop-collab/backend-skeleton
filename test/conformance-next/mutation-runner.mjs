import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluateMutationGate } from './harness.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveSourceCommit(repoRoot, requested = null) {
  const run = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  if (run.status !== 0) throw new Error(`cannot resolve source commit for ${repoRoot}: ${(run.stderr ?? '').trim()}`);
  const actual = (run.stdout ?? '').trim();
  if (!/^[a-f0-9]{40}$/.test(actual)) throw new Error(`git rev-parse returned an invalid commit: ${actual}`);
  if (requested !== null) {
    if (!/^[a-f0-9]{40}$/.test(requested)) throw new Error('--source-commit must be a canonical lowercase 40-hex commit');
    if (requested !== actual) throw new Error(`--source-commit ${requested} does not match tested checkout ${actual}`);
  }
  const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', timeout: 10_000 });
  if (status.status !== 0) throw new Error(`cannot inspect checkout cleanliness for ${repoRoot}: ${(status.stderr ?? '').trim()}`);
  if ((status.stdout ?? '').trim()) throw new Error('mutation reports require a clean checkout; uncommitted or untracked bytes would not match source_commit');
  return actual;
}

function validateCampaignSourceCommit(repoRoot, sourceCommit) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) {
    throw new Error('mutation campaign sourceCommit must be a canonical lowercase 40-hex commit');
  }
  const type = spawnSync('git', ['-C', repoRoot, 'cat-file', '-t', sourceCommit], { encoding: 'utf8', timeout: 10_000 });
  if (type.status !== 0 || (type.stdout ?? '').trim() !== 'commit') {
    throw new Error('mutation campaign sourceCommit must resolve to a Git commit object');
  }
  return sourceCommit;
}

function safeRepoPath(rel) {
  return nonEmptyString(rel) &&
    !path.isAbsolute(rel) &&
    !rel.includes('\\') &&
    !rel.split('/').includes('..') &&
    (rel.startsWith('test/conformance-next/') || rel.startsWith('test/corpus-next/'));
}

export function validateMutationCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return { ok: false, errors: ['catalog must be an object'] };
  if (catalog.contract !== 'sbf.qa-mutation-catalog/1') errors.push('contract must be sbf.qa-mutation-catalog/1');
  if (!Array.isArray(catalog.mutants) || catalog.mutants.length === 0) errors.push('mutants must be a non-empty array');
  if (errors.length) return { ok: false, errors };

  const ids = new Set();
  for (const [i, mutant] of catalog.mutants.entries()) {
    const at = `mutants[${i}]`;
    if (!nonEmptyString(mutant.id)) errors.push(`${at}.id must be non-empty`);
    else if (ids.has(mutant.id)) errors.push(`duplicate mutant id: ${mutant.id}`);
    else ids.add(mutant.id);
    if (typeof mutant.critical !== 'boolean') errors.push(`${at}.critical must be boolean`);
    if (!safeRepoPath(mutant.file)) errors.push(`${at}.file must stay inside T19 test paths`);
    if (!nonEmptyString(mutant.find) || !nonEmptyString(mutant.replace) || mutant.find === mutant.replace) errors.push(`${at} needs distinct non-empty find/replace strings`);
    if (!Array.isArray(mutant.test_files) || mutant.test_files.length === 0 || mutant.test_files.some((p) => !safeRepoPath(p) || !p.endsWith('.test.mjs'))) {
      errors.push(`${at}.test_files must name T19 test files`);
    }
    if (!nonEmptyString(mutant.invariant)) errors.push(`${at}.invariant must be non-empty`);
  }
  return { ok: errors.length === 0, errors, stats: { mutants: catalog.mutants.length } };
}

function materializeT19Tree(repoRoot, scratch, sourceCommit) {
  fs.mkdirSync(scratch,{recursive:true});
  // Archive the exact commit rather than pathspecs. Git does not track empty directories,
  // so an otherwise valid fixture can legitimately have no test/corpus-next tree. Mutations
  // are still restricted to T19-owned paths by validateMutationCatalog.
  const archive=spawnSync('git',['-C',repoRoot,'archive','--format=tar',sourceCommit],{
    encoding:null,timeout:20_000,maxBuffer:128*1024*1024,
  });
  if(archive.status!==0) throw new Error(`git archive source commit failed: ${Buffer.from(archive.stderr??'').toString('utf8').trim()}`);
  const extract=spawnSync('tar',['-xf','-','-C',scratch],{input:archive.stdout,encoding:'utf8',timeout:20_000,maxBuffer:8*1024*1024});
  if(extract.status!==0) throw new Error(`tar extract T19 tree failed: ${(extract.stderr??'').trim()}`);
}

function runScratchGit(scratch,args) {
  const run=spawnSync('git',args,{
    cwd:scratch,encoding:'utf8',timeout:20_000,
    env:{...process.env,GIT_AUTHOR_NAME:'T19 mutation runner',GIT_AUTHOR_EMAIL:'t19@example.invalid',GIT_COMMITTER_NAME:'T19 mutation runner',GIT_COMMITTER_EMAIL:'t19@example.invalid'},
  });
  if(run.status!==0) throw new Error(`scratch git ${args.join(' ')} failed: ${(run.stderr??'').trim()}`);
}

function initializeScratchGit(scratch) {
  runScratchGit(scratch,['init','-q']);
  runScratchGit(scratch,['config','gc.auto','0']);
  runScratchGit(scratch,['config','maintenance.auto','false']);
  runScratchGit(scratch,['add','-A']);
  runScratchGit(scratch,['commit','--quiet','-m','exact-source baseline']);
}

function runTestFiles(scratch, testFiles, timeoutMs) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const args = ['--test', ...testFiles.map((p) => path.join(scratch, p))];
  const run = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', timeout: timeoutMs, env });
  return {
    exit_code: Number.isInteger(run.status) ? run.status : null,
    signal: run.signal ?? null,
    stderr_tail: (run.stderr ?? '').slice(-1200),
    stdout_tail: (run.stdout ?? '').slice(-1200),
  };
}

function applyOneMutation(scratch, mutant) {
  const file = path.join(scratch, mutant.file);
  const original = fs.readFileSync(file, 'utf8');
  const first = original.indexOf(mutant.find);
  const last = original.lastIndexOf(mutant.find);
  if (first === -1) return { ok: false, reason: 'mutation anchor not found' };
  if (first !== last) return { ok: false, reason: 'mutation anchor is not unique' };
  fs.writeFileSync(file, original.slice(0, first) + mutant.replace + original.slice(first + mutant.find.length));
  return { ok: true };
}

export function runMutationCampaign({ repoRoot, catalog, sourceCommit = null }) {
  const validation = validateMutationCatalog(catalog);
  if (!validation.ok) return { pass: false, catalog_errors: validation.errors, mutants: [], gate: null };
  const resolvedSourceCommit = validateCampaignSourceCommit(repoRoot, sourceCommit ?? resolveSourceCommit(repoRoot));

  const results = [];
  for (const mutant of catalog.mutants) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t19-mutant-'));
    try {
      materializeT19Tree(repoRoot, scratch, resolvedSourceCommit);
      initializeScratchGit(scratch);
      const baseline = runTestFiles(scratch, mutant.test_files, 10_000);
      if (baseline.exit_code !== 0) {
        results.push({ id: mutant.id, critical: mutant.critical, status: 'survived', classification: 'baseline-failed', reason: 'unmodified scratch test suite did not pass; mutant cannot be counted as killed', baseline });
        continue;
      }
      const applied = applyOneMutation(scratch, mutant);
      if (!applied.ok) {
        results.push({ id: mutant.id, critical: mutant.critical, status: 'survived', classification: 'mutation-not-applied', reason: applied.reason, baseline });
        continue;
      }
      const run = runTestFiles(scratch, mutant.test_files, 10_000);
      const killed = Number.isInteger(run.exit_code) && run.exit_code !== 0;
      results.push({
        id: mutant.id,
        critical: mutant.critical,
        status: killed ? 'killed' : 'survived',
        classification: killed ? 'mutant-detected' : 'mutant-survived',
        baseline,
        exit_code: run.exit_code,
        signal: run.signal,
        stderr_tail: run.stderr_tail,
        stdout_tail: run.stdout_tail,
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  const gate = evaluateMutationGate({ mutants: results.map(({ id, critical, status }) => ({ id, critical, status })) });
  return { pass: gate.pass, catalog_errors: [], mutants: results, gate, source_materialization: 'git-archive', source_commit: resolvedSourceCommit };
}


function parseArgs(argv) {
  const out = { repo_root: '.', catalog: null, out: null, source_commit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo-root') { out.repo_root = argv[++i] ?? null; continue; }
    if (argv[i] === '--catalog') { out.catalog = argv[++i] ?? null; continue; }
    if (argv[i] === '--out') { out.out = argv[++i] ?? null; continue; }
    if (argv[i] === '--source-commit') { out.source_commit = argv[++i] ?? null; continue; }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.repo_root || !out.catalog) throw new Error('--repo-root and --catalog are required');
  return out;
}

export function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  try {
    const options = parseArgs(argv);
    const catalog = JSON.parse(fs.readFileSync(options.catalog, 'utf8'));
    const source_commit = resolveSourceCommit(options.repo_root, options.source_commit);
    const catalog_sha256 = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    const report = runMutationCampaign({ repoRoot: options.repo_root, catalog, sourceCommit: source_commit });
    const encoded = JSON.stringify({ contract: 'sbf.qa-mutation-report/1', catalog_sha256, ...report }, null, 2) + '\n';
    if (options.out) fs.writeFileSync(options.out, encoded);
    else stdout.write(encoded);
    stderr.write(`qa-mutation: ${report.pass ? 'PASS' : 'FAIL'} -- ${report.mutants.filter((m) => m.status === 'killed').length}/${report.mutants.length} mutants killed\n`);
    return report.pass ? 0 : 3;
  } catch (err) {
    stderr.write(`qa-mutation: ${err.message}\n`);
    return 1;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entry && entry === fileURLToPath(import.meta.url)) process.exitCode = main();
