// Recorded runs of a real CLI. A case prepares its input files in a temp directory of its own, the CLI is spawned, and the
// report keeps what it printed: exit code, error codes and a hash of stdout. A case whose run differs from its declared
// expectation throws, so a report can only contain observed behaviour.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from './verify-baseline.mjs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export const failCodes = (stdout) => [...new Set(stdout.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.split(' ')[1]))].sort();

// case: { id, mutation, exit, codes, prepare(dir) -> { argv, display, scrub? } }; prepare may be async. The CLI gets the PATH
// only. `scrub` lists directory names that the CLI may print; they are recorded as <repo> so that a rerun gives the same
// record. stderr_head is the CLI's first error line up to its first ": ", which names the failure without a runtime's wording.
export async function runRecorded(cli, c, dir) {
  const { argv, display, scrub = [] } = await c.prepare(fs.mkdtempSync(path.join(dir, 'case-')));
  const res = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  if (res.error) throw res.error;
  const errorLine = res.stderr.split('\n')[0];
  if (/\n\s+at |Node\.js v\d/.test(res.stderr)) throw new Error(`${c.id}: the CLI crashed instead of reporting: ${errorLine}`);
  const lines = res.stdout.split('\n').filter(Boolean);
  const codes = failCodes(res.stdout);
  if (res.status !== c.exit || JSON.stringify(codes) !== JSON.stringify(c.codes)) {
    throw new Error(`${c.id}: expected exit ${c.exit} codes ${JSON.stringify(c.codes)}, the CLI gave exit ${res.status} codes ${JSON.stringify(codes)}`);
  }
  const stderrHead = scrub.reduce((line, d) => line.replaceAll(d, '<repo>'), errorLine).split(': ')[0];
  return { id: c.id, mutation: c.mutation, command: display, exit_code: res.status, codes, stdout_first_line: lines[0] ?? '', stdout_sha256: sha256(res.stdout), stderr_head: stderrHead };
}

export async function runAll(cli, cases) {
  const ids = cases.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('two cases share an id');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't00-runs-'));
  try {
    const out = [];
    for (const c of cases) out.push(await runRecorded(cli, c, dir));
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Differences between a committed report and a freshly recorded one, as sentences. A member only one side has is a
// difference too, at the top level and in every case.
export function diffReports(report, fresh) {
  if (typeof report !== 'object' || report === null || Array.isArray(report)) return ['the report is not an object'];
  const errors = [];
  for (const key of [...new Set([...Object.keys(report), ...Object.keys(fresh)])].filter((k) => k !== 'cases').sort()) {
    if (canonicalJson(report[key]) !== canonicalJson(fresh[key])) errors.push(`${key} differs from the recomputed value`);
  }
  if (!Array.isArray(report.cases) || report.cases.length !== fresh.cases.length) {
    errors.push('case count differs from the recomputed report');
    return errors;
  }
  fresh.cases.forEach((want, i) => {
    const have = report.cases[i] ?? {};
    for (const key of [...new Set([...Object.keys(have), ...Object.keys(want)])].sort()) {
      if (canonicalJson(have[key]) !== canonicalJson(want[key])) errors.push(`case ${want.id}: ${key} differs from the recomputed value`);
    }
  });
  return errors;
}
