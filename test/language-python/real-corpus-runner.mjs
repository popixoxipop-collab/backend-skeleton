#!/usr/bin/env node
// Development-only real-repository corpus runner for T06.
// It parses pinned source bytes through the T06 AST helper; it never imports or starts target apps.
// Independent support certification/holdout selection belongs to T19.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzePythonFiles } from '../../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts } from '../../scanners/language/python/resolver.mjs';
import { buildFastApiShadow } from '../../scanners/language/python/fastapi-shadow.mjs';
import { buildFlaskRouteShadow } from '../../scanners/language/python/flask-shadow.mjs';
import { buildDjangoUrlShadow } from '../../scanners/language/python/django-shadow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, 'real-corpus.manifest.json'), 'utf8'));

function parseRoots(argv) {
  const roots = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--root') continue;
    const value = argv[++i];
    if (!value || !value.includes('=')) throw new Error('--root requires id=/absolute/or/relative/checkout');
    const eq = value.indexOf('=');
    const id = value.slice(0, eq);
    const root = value.slice(eq + 1);
    if (!id || !root) throw new Error('--root requires non-empty id and path');
    if (roots.has(id)) throw new Error(`duplicate --root for ${id}`);
    roots.set(id, path.resolve(root));
  }
  return roots;
}

function gitHead(checkout) {
  const run = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  if (run.status !== 0) {
    throw new Error(`cannot read git HEAD for ${checkout}: ${String(run.stderr || run.error?.message || '').trim()}`);
  }
  return String(run.stdout || '').trim();
}

function project(repoRoot, files) {
  const batch = analyzePythonFiles({ repoRoot, files });
  const failed = batch.results.filter((entry) => !entry.ok);
  assert.deepEqual(failed, [], `Python analysis failed: ${JSON.stringify(failed, null, 2)}`);
  return buildPythonProjectFacts(batch.results);
}

function uniqSorted(values) {
  return [...new Set(values)].sort();
}

function resultFor(entry, checkout) {
  const repoRoot = path.join(checkout, entry.repoSubroot || '');
  const p = project(repoRoot, entry.files);
  if (entry.projection === 'fastapi-shadow') {
    const shadow = buildFastApiShadow(p);
    return {
      endpointKeys: shadow.endpoints.map((x) => `${x.verb} ${x.path}#${x.method}`),
      entities: shadow.entities.map((x) => [x.className, x.primaryKeyFields]),
      dtoCount: shadow.dtos.length,
      unknownReasons: uniqSorted(shadow.unknowns.map((x) => x.reason)),
    };
  }
  if (entry.projection === 'flask-shadow') {
    const shadow = buildFlaskRouteShadow(p);
    return {
      routes: shadow.registrations.map((x) => [x.function, x.path, x.methods, x.methodsStatus]),
      unknownReasons: uniqSorted(shadow.unknowns.map((x) => x.reason)),
    };
  }
  if (entry.projection === 'django-shadow') {
    const shadow = buildDjangoUrlShadow(p);
    return {
      registrationCount: shadow.registrations.length,
      unknownReasons: uniqSorted(shadow.unknowns.map((x) => x.reason)),
      registrations: shadow.registrations.map((x) => [
        x.kind,
        x.patternSegments.map((segment) => segment.value).join(''),
        x.name,
        x.target?.module || null,
        x.target?.name || null,
      ]),
    };
  }
  throw new Error(`unknown corpus projection ${entry.projection}`);
}

function verify(entry, actual) {
  if (entry.projection === 'django-shadow') {
    assert.equal(actual.registrationCount, entry.expect.registrationCount, `${entry.id}: registration count drift`);
    assert.deepEqual(actual.unknownReasons, entry.expect.unknownReasons, `${entry.id}: unknown-reason drift`);
    for (const required of entry.expect.requiredRegistrations) {
      assert.ok(actual.registrations.some((x) => JSON.stringify(x) === JSON.stringify(required)),
        `${entry.id}: required registration missing: ${JSON.stringify(required)}`);
    }
    return;
  }
  assert.deepEqual(actual, entry.expect, `${entry.id}: pinned corpus drift`);
}

const roots = parseRoots(process.argv.slice(2));
const reports = [];
for (const entry of MANIFEST.cases) {
  const checkout = roots.get(entry.id);
  if (!checkout) throw new Error(`missing --root ${entry.id}=<checkout>`);
  const head = gitHead(checkout);
  assert.equal(head, entry.commit, `${entry.id}: checkout HEAD is not the pinned corpus commit`);
  const actual = resultFor(entry, checkout);
  verify(entry, actual);
  reports.push({
    id: entry.id,
    repository: entry.repository,
    commit: entry.commit,
    license: entry.license,
    projection: entry.projection,
    result: 'pass',
  });
}
console.log(JSON.stringify({
  schema: 'bskel.t06.real-corpus-result/1',
  role: MANIFEST.role,
  targetExecution: false,
  cases: reports,
}, null, 2));
