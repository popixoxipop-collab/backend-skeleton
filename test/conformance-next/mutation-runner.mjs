import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateMutationGate } from './harness.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

function copyT19Tree(repoRoot, scratch) {
  for (const rel of ['test/conformance-next', 'test/corpus-next']) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(scratch, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, dereference: false, errorOnExist: false });
  }
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

export function runMutationCampaign({ repoRoot, catalog }) {
  const validation = validateMutationCatalog(catalog);
  if (!validation.ok) return { pass: false, catalog_errors: validation.errors, mutants: [], gate: null };

  const results = [];
  for (const mutant of catalog.mutants) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t19-mutant-'));
    try {
      copyT19Tree(repoRoot, scratch);
      const applied = applyOneMutation(scratch, mutant);
      if (!applied.ok) {
        results.push({ id: mutant.id, critical: mutant.critical, status: 'survived', reason: applied.reason, exit_code: null });
        continue;
      }
      const args = ['--test', ...mutant.test_files.map((p) => path.join(scratch, p))];
      const run = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', timeout: 10_000 });
      const code = run.status;
      const killed = Number.isInteger(code) && code !== 0;
      results.push({
        id: mutant.id,
        critical: mutant.critical,
        status: killed ? 'killed' : 'survived',
        exit_code: Number.isInteger(code) ? code : null,
        signal: run.signal ?? null,
        stderr_tail: (run.stderr ?? '').slice(-1200),
        stdout_tail: (run.stdout ?? '').slice(-1200),
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  const gate = evaluateMutationGate({ mutants: results.map(({ id, critical, status }) => ({ id, critical, status })) });
  return { pass: gate.pass, catalog_errors: [], mutants: results, gate };
}
