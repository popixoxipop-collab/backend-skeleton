// Runtime oracle for the Hono scope record: imports each fixture app against the REAL pinned hono
// (installed next to this file), sends every candidate request through app.request() and records the
// status. "exists" means a status other than 404 or 405. Output is deterministic JSON on stdout
// (no ports, paths, times). Besides the probes it records the app's own registered route table
// (app.routes); the probes cannot discover a served route that is not on the candidate list.
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
// sha256 over "path\nfilehash\n" of every fixture file: binds this output to the exact fixture bytes it ran.
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
  ['GET', '/api/v1/status', '/api/v1/status'], ['DELETE', '/api/v1/sessions/:sid', '/api/v1/sessions/s1'],
  ['GET', '/status', '/status'], ['GET', '/v1/status', '/v1/status'], ['PUT', '/users', '/users'],
];
const COUNTER = [
  ['GET', '/open', '/open'], ['GET', '/secret/data', '/secret/data'], ['GET', '/secret/data', '/secret/data', A],
  ['GET', '/gen/alpha', '/gen/alpha'], ['GET', '/gen/beta', '/gen/beta'],
  ['GET', '/widgets', '/widgets'], ['POST', '/widgets', '/widgets'], ['GET', '/', '/'], ['POST', '/', '/'],
  ['GET', '/svc/ping', '/svc/ping'], ['GET', '/ping', '/ping'],
  ['GET', '/orgs/:org/list', '/orgs/acme/list'], ['GET', '/list', '/list'],
  ['GET', '/chain', '/chain'], ['POST', '/chain', '/chain'], ['GET', '/any', '/any'], ['POST', '/any', '/any'],
  ['GET', '/a1', '/a1'], ['GET', '/a2', '/a2'], ['GET', '/legacy/old', '/legacy/old'], ['GET', '/old', '/old'],
];
const SCENARIOS = [
  { id: 'hono-normal', fixture: 'normal', env: {}, probes: NORMAL },
  { id: 'hono-counterexample', fixture: 'counterexample', env: {}, probes: COUNTER },
  { id: 'hono-counterexample-env-v2', fixture: 'counterexample', env: { API_BASE: '/v2' }, probes: [['GET', '/v2/ping', '/v2/ping'], ['GET', '/svc/ping', '/svc/ping']] },
];

async function runScenario(s) {
  delete process.env.API_BASE;
  Object.assign(process.env, s.env);
  const file = path.join(here, s.fixture, 'src/app.js');
  const app = (await import(`${pathToFileURL(file).href}?scenario=${s.id}`)).default;
  const probes = [];
  for (const [method, route, sample, auth = T] of s.probes) {
    const res = await app.request(sample, { method, headers: auth === T ? { 'x-token': 'ok' } : {} });
    await res.arrayBuffer();
    probes.push({ method, route, sample, auth, status: res.status });
  }
  return { id: s.id, fixture: s.fixture, fixtureDigest: treeDigest(s.fixture), env: s.env, registered: app.routes.map((r) => `${r.method} ${r.path}`).sort(), probes };
}

const scenarios = [];
for (const s of SCENARIOS) scenarios.push(await runScenario(s));
const version = JSON.parse(fs.readFileSync(path.join(here, 'node_modules/hono/package.json'), 'utf8')).version;
process.stdout.write(`${JSON.stringify({ schema: 'bskel.http-scope-oracle/2', command: COMMAND, startEnv: START_ENV, lock: LOCK, framework: { name: 'hono', version }, scenarios }, null, 1)}\n`);
