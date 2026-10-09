// Runtime oracle for the NestJS scope record: loads each COMPILED fixture app (dist/, built by tsc from
// the committed sources) under the REAL pinned @nestjs packages, listens on 127.0.0.1 with an ephemeral
// port and records the HTTP status of every candidate request. "exists" means a status other than
// 404 or 405. Output is deterministic JSON on stdout (no ports, paths, times). Probes cannot discover
// a served route that is not on the candidate list.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Hermetic start: remember which variable NAMES the caller passed in (the verifier compares them with the
// record's runEnv), then drop every one of them and pin PATH and NODE_ENV.
const START_ENV = Object.keys(process.env).sort();
for (const k of START_ENV) delete process.env[k];
process.env.PATH = '/usr/bin:/bin';
process.env.NODE_ENV = 'production';
if (process.argv.length !== 2) { process.stderr.write(`oracle.mjs takes no arguments, got: ${process.argv.slice(2).join(' ')}\n`); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const COMMAND = ['node', path.relative(process.cwd(), process.argv[1]).split(path.sep).join('/')];
// Fail closed on the install: the committed lock must exist and every locked package must be installed at exactly
// the locked version (npm ci --ignore-scripts). A missing or different package throws; it is never skipped.
function lockBinding() {
  const raw = fs.readFileSync(path.join(here, 'package-lock.json'));
  const lock = JSON.parse(raw);
  let installed = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    const manifest = path.join(here, key, 'package.json');
    if (!fs.existsSync(manifest)) { if (entry.optional || entry.devOptional) continue; throw new Error(`locked package is not installed: ${key}`); }
    const got = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    if (got !== entry.version) throw new Error(`installed ${key} is ${got}, the lock says ${entry.version}`);
    installed += 1;
  }
  return { file: 'package-lock.json', sha256: sha(raw), packages: Object.keys(lock.packages).length - 1, installed };
}
const LOCK = lockBinding();
// sha256 over "path\nfilehash\n" of every fixture source file: binds this output to the exact fixture bytes it ran.
function treeDigest(rel) {
  const files = [];
  const visit = (r) => {
    for (const e of fs.readdirSync(path.join(here, rel, r), { withFileTypes: true })) {
      const n = r ? `${r}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!['node_modules', 'dist', '.next'].includes(e.name)) visit(n); } else files.push(n);
    }
  };
  visit('');
  return sha(files.sort().map((f) => `${f}\n${sha(fs.readFileSync(path.join(here, rel, f)))}\n`).join(''));
}
const T = 'token';
const A = 'anon';
const NORMAL = [
  ['GET', '/health', '/health'], ['GET', '/users', '/users'], ['POST', '/users', '/users'], ['GET', '/users/:id', '/users/7'],
  ['DELETE', '/users/:id', '/users/7'], ['PUT', '/users', '/users'], ['GET', '/', '/'], ['GET', '/api/users', '/api/users'],
];
const COUNTER = [
  ['GET', '/open', '/open'], ['GET', '/svc/open', '/svc/open'],
  ['GET', '/secure/data', '/secure/data'], ['GET', '/secure/data', '/secure/data', A],
  ['GET', '/gen/item/alpha', '/gen/item/alpha'],
  ['GET', '/widgets', '/widgets'], ['POST', '/widgets', '/widgets'], ['GET', '/', '/'],
  ['GET', '/admin/reports', '/admin/reports'], ['GET', '/reports', '/reports'],
];
const SCENARIOS = [
  { id: 'nestjs-normal', fixture: 'normal', factory: 'createApp', env: {}, probes: NORMAL },
  { id: 'nestjs-counterexample', fixture: 'counterexample', factory: 'createApp', env: {}, probes: COUNTER },
  { id: 'nestjs-counterexample-prefixed', fixture: 'counterexample', factory: 'createPrefixedApp', env: {}, probes: [['GET', '/svc/open', '/svc/open'], ['GET', '/open', '/open']] },
  { id: 'nestjs-counterexample-prefixed-env-v2', fixture: 'counterexample', factory: 'createPrefixedApp', env: { API_BASE: '/v2' }, probes: [['GET', '/v2/open', '/v2/open'], ['GET', '/svc/open', '/svc/open']] },
];

async function runScenario(s) {
  delete process.env.API_BASE;
  Object.assign(process.env, s.env);
  const mod = await import(`${pathToFileURL(path.join(here, 'dist', s.fixture, 'src/main.js')).href}?scenario=${s.id}`);
  const app = await mod[s.factory]();
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address();
  const probes = [];
  for (const [method, route, sample, auth = T] of s.probes) {
    const res = await fetch(`http://127.0.0.1:${port}${sample}`, { method, redirect: 'manual', headers: auth === T ? { 'x-token': 'ok' } : {} });
    await res.arrayBuffer();
    probes.push({ method, route, sample, auth, status: res.status });
  }
  await app.close();
  return { id: s.id, fixture: s.fixture, factory: s.factory, fixtureDigest: treeDigest(s.fixture), env: s.env, probes };
}

const scenarios = [];
for (const s of SCENARIOS) scenarios.push(await runScenario(s));
const pkg = (name) => JSON.parse(fs.readFileSync(path.join(here, 'node_modules', name, 'package.json'), 'utf8')).version;
process.stdout.write(`${JSON.stringify({ schema: 'bskel.http-scope-oracle/2', command: COMMAND, startEnv: START_ENV, lock: LOCK, framework: { name: '@nestjs/core', version: pkg('@nestjs/core'), packages: { '@nestjs/common': pkg('@nestjs/common'), '@nestjs/platform-express': pkg('@nestjs/platform-express'), typescript: pkg('typescript') } }, scenarios }, null, 1)}\n`);
