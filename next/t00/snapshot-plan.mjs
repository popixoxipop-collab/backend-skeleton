#!/usr/bin/env node
// Snapshot of the write scopes in the scale plan backlog: the one part of the plan that says which track may write where.
// The plan folder is in no repository, so the committed snapshot is the copy that the ownership map is derived from and
// checked against. `--check` recomputes the snapshot from a backlog file, validates the committed one on its own and
// compares the two; that is a maintainer step (CI has no backlog), and the snapshot's own shape and derived facts are
// checked on every test run.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isObject, isText, isTexts, matches, normalizeScopes, scopeProblem, TRACK_ID } from './ownership.mjs';
import { canonicalJson } from './verify-baseline.mjs';

export const PLAN_SCHEMA = 'bskel.t00-plan-write-scopes/1';
export const BACKLOG_SCHEMA = 'bskel.scale-backlog/1';
export const PLAN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plan-write-scopes.json');
const HEX64 = /^[0-9a-f]{64}$/;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function snapshotPlan(bytes) {
  let backlog;
  try {
    backlog = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new Error(`the backlog is not valid JSON: ${e.message}`);
  }
  if (!isObject(backlog) || backlog.schema !== BACKLOG_SCHEMA || !Array.isArray(backlog.tasks)) throw new Error(`the backlog is not a ${BACKLOG_SCHEMA} document with a tasks array`);
  const tasks = backlog.tasks.map((t, i) => {
    if (!isObject(t) || !isText(t.id) || !isText(t.track) || !isText(t.repository) || !isTexts(t.write_scope)) {
      throw new Error(`task ${i}${isObject(t) && isText(t.id) ? ` (${t.id})` : ''} lacks a string id, track, repository or an array write_scope`);
    }
    return { id: t.id, track: t.track, repository: t.repository, write_scope: [...t.write_scope] };
  }).sort(byId);
  return {
    schema: PLAN_SCHEMA,
    task_id: 'T00-02',
    generator: 'node next/t00/snapshot-plan.mjs <backlog.json> next/t00/fixtures/plan-write-scopes.json',
    source: {
      description: 'id, track, repository and write_scope of every task in planning/backlog.json of the scale plan folder (in no repository)',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      backlog_schema: backlog.schema,
      task_count: tasks.length,
    },
    tasks,
  };
}

// Shape and internal consistency of a snapshot document; a track must live in one repository and every scope must parse.
export function planProblems(snap) {
  if (!isObject(snap)) return ['the plan snapshot is not an object'];
  const problems = [];
  if (snap.schema !== PLAN_SCHEMA) problems.push(`schema is not ${PLAN_SCHEMA}`);
  if (snap.task_id !== 'T00-02') problems.push('task_id is not T00-02');
  const s = snap.source;
  const sourceOk = isObject(s) && Number.isSafeInteger(s.bytes) && s.bytes > 0 && matches(HEX64, s.sha256) && s.backlog_schema === BACKLOG_SCHEMA && Number.isSafeInteger(s.task_count);
  if (!sourceOk) problems.push('source lacks bytes, sha256, backlog_schema or task_count of the right type');
  if (!Array.isArray(snap.tasks) || snap.tasks.length === 0) return [...problems, 'tasks is not a non-empty array'];
  if (sourceOk && s.task_count !== snap.tasks.length) problems.push(`source.task_count is ${s.task_count} but the snapshot holds ${snap.tasks.length} tasks`);
  const ids = new Set();
  const repositoryOf = new Map();
  for (const [i, t] of snap.tasks.entries()) {
    if (!isObject(t) || !isText(t.id) || !matches(TRACK_ID, t.track) || !isText(t.repository) || !isTexts(t.write_scope)) {
      problems.push(`task ${i} is not {id, track Tnn, repository, write_scope[]}`);
      continue;
    }
    if (ids.has(t.id)) problems.push(`task id ${t.id} appears more than once`);
    ids.add(t.id);
    if (repositoryOf.has(t.track) && repositoryOf.get(t.track) !== t.repository) problems.push(`track ${t.track} has tasks in two repositories (${repositoryOf.get(t.track)}, ${t.repository})`);
    else repositoryOf.set(t.track, t.repository);
    for (const scope of t.write_scope) {
      const problem = scopeProblem(scope);
      if (problem) problems.push(`task ${t.id}: write scope ${JSON.stringify(scope)}: ${problem}`);
    }
  }
  return problems;
}

// [{track, repository, write_scopes}] sorted by track, for a snapshot that planProblems accepted.
export function planTracks(snap) {
  const byTrack = new Map();
  for (const t of snap.tasks) {
    const entry = byTrack.get(t.track) ?? { track: t.track, repository: t.repository, scopes: [] };
    entry.scopes.push(...t.write_scope);
    byTrack.set(t.track, entry);
  }
  return [...byTrack.values()].sort((a, b) => (a.track < b.track ? -1 : 1)).map((e) => ({ track: e.track, repository: e.repository, write_scopes: normalizeScopes(e.scopes) }));
}

// Header pretty-printed, one task per line: a 291-task snapshot stays readable in a diff.
export function serializeSnapshot(snap) {
  const { tasks, ...head } = snap;
  return `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "tasks": [\n${tasks.map((t) => `    ${JSON.stringify(t)}`).join(',\n')}\n  ]\n}\n`;
}

// A task listed twice stays two entries here: the lists are grouped by id with every entry kept, never collapsed to one.
const tasksById = (tasks) => {
  const groups = new Map();
  for (const t of tasks) groups.set(t?.id, [...(groups.get(t?.id) ?? []), canonicalJson(t)]);
  return groups;
};

// What differs between a committed snapshot and the one generated from the backlog; [] only when the two are equal.
export function snapshotDifferences(committed, fresh) {
  const out = [];
  if (!isObject(committed)) return ['the committed snapshot is not an object'];
  for (const key of ['schema', 'task_id', 'generator']) if (committed[key] !== fresh[key]) out.push(`${key} differs`);
  for (const key of Object.keys(fresh.source)) if (canonicalJson(committed.source?.[key]) !== canonicalJson(fresh.source[key])) out.push(`source.${key} differs (backlog ${fresh.source[key]}, snapshot ${committed.source?.[key]})`);
  if (Array.isArray(committed.tasks)) {
    const have = tasksById(committed.tasks);
    const want = tasksById(fresh.tasks);
    for (const [id, wanted] of want) {
      const held = have.get(id) ?? [];
      if (held.length === 0) out.push(`task ${id} is missing from the snapshot`);
      else if (held.length !== wanted.length) out.push(`task ${id} appears ${held.length} times in the snapshot but ${wanted.length} in the backlog`);
      else if (held.some((text, i) => text !== wanted[i])) out.push(`task ${id} differs`);
    }
    for (const id of have.keys()) if (!want.has(id)) out.push(`task ${id} is not in the backlog`);
  } else out.push('tasks is not an array');
  if (out.length === 0 && canonicalJson(committed) !== canonicalJson(fresh)) out.push('the snapshot has a member the generator does not write, or lists the tasks in another order');
  return out;
}

const USAGE = `usage: node next/t00/snapshot-plan.mjs <backlog.json> <out.json>
       node next/t00/snapshot-plan.mjs --check <backlog.json> [<snapshot.json>]
exit codes: 0 written or equal, 2 the snapshot differs from the backlog or is not a valid snapshot, 1 usage or unreadable input`;

export function runCli(argv) {
  const check = argv[0] === '--check';
  const files = check ? argv.slice(1) : argv;
  if (files.some((f) => f.startsWith('--')) || (check ? files.length < 1 || files.length > 2 : files.length !== 2)) {
    console.error(`wrong arguments\n${USAGE}`);
    return 1;
  }
  let fresh;
  let committed;
  try {
    fresh = snapshotPlan(fs.readFileSync(files[0]));
    const problems = planProblems(fresh);
    if (problems.length) throw new Error(`the backlog yields an invalid snapshot: ${problems[0]}`);
    if (check) committed = JSON.parse(fs.readFileSync(files[1] ?? PLAN_FILE, 'utf8'));
  } catch (e) {
    console.error(`cannot use input: ${e.message}\n${USAGE}`);
    return 1;
  }
  if (!check) {
    fs.writeFileSync(files[1], serializeSnapshot(fresh));
    console.log(`wrote ${files[1]}: ${fresh.tasks.length} tasks from ${fresh.source.bytes} bytes, sha256 ${fresh.source.sha256}`);
    return 0;
  }
  const invalid = planProblems(committed);
  const differences = snapshotDifferences(committed, fresh);
  for (const p of invalid) console.log(`FAIL PLAN_SNAPSHOT_STALE snapshot is not valid: ${p}`);
  for (const d of differences) console.log(`FAIL PLAN_SNAPSHOT_STALE snapshot ${d}`);
  if (invalid.length > 0 || differences.length > 0) return 2;
  console.log(`OK the snapshot is valid and equals the backlog: ${fresh.tasks.length} tasks, sha256 ${fresh.source.sha256}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
