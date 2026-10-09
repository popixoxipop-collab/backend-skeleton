// Runtime oracle for the Express scope records: loads each fixture app under the REAL pinned
// express (read from node_modules at run time), serves it on 127.0.0.1 with an ephemeral port and
// records the HTTP status of every candidate route. "exists" means status is neither 404 nor 405.
// Output is deterministic JSON on stdout (no ports, paths, times). Candidate routes are authored
// below; this oracle cannot discover routes outside the candidate set.
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
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

const NORMAL_TS = [
  ['GET', '/api/health', '/api/health'], ['GET', '/api/v1/users', '/api/v1/users'], ['GET', '/api/v1/users/:id', '/api/v1/users/7'],
  ['POST', '/api/v1/users', '/api/v1/users'], ['GET', '/api/v1/orders/search', '/api/v1/orders/search'], ['GET', '/api/v1/orders/:orderId', '/api/v1/orders/9'],
  ['DELETE', '/api/v1/users/:id', '/api/v1/users/7'], ['GET', '/api/v1/orders', '/api/v1/orders'], ['GET', '/v1/users', '/v1/users'],
  ['GET', '/api/v1/users/:id', '/api/v1/users/7', A],
];
const NORMAL_JS = [
  ['GET', '/api/ping', '/api/ping'], ['GET', '/api/user/list', '/api/user/list'], ['GET', '/api/user/:userUid', '/api/user/abc'],
  ['PATCH', '/api/user/:userUid', '/api/user/abc'], ['GET', '/api/order/search', '/api/order/search'], ['GET', '/api/order/:orderId', '/api/order/9'],
  ['DELETE', '/api/user/:userUid', '/api/user/abc'], ['GET', '/ping', '/ping'], ['GET', '/user/list', '/user/list'],
  ['GET', '/api/user/:userUid', '/api/user/abc', A],
];
const COUNTER = (base) => [
  ['GET', '/open', '/open'], ['GET', '/secret', '/secret'], ['GET', '/secret', '/secret', A],
  ['GET', '/gen/alpha', '/gen/alpha'], ['GET', '/gen/beta', '/gen/beta'],
  ['GET', '/chain', '/chain'], ['POST', '/chain', '/chain'], ['GET', '/any', '/any'], ['POST', '/any', '/any'],
  ['GET', '/a1', '/a1'], ['GET', '/a2', '/a2'], ['GET', '/inline', '/inline'],
  ['GET', '/api/status', '/api/status'], ['GET', '/status', '/status'], ['GET', '/legacy/old', '/legacy/old'], ['GET', '/old', '/old'],
  ['GET', '/widgets', '/widgets'], ['POST', '/widgets', '/widgets'], ['GET', '/', '/'], ['POST', '/', '/'],
  ['GET', `${base}/ping`, `${base}/ping`], ['GET', '/ping', '/ping'],
];
const SCENARIOS = [
  { id: 'ts-normal', fixture: 'typescript/normal', load: ['cjs', 'dist/typescript/normal/src/app.js'], env: {}, probes: NORMAL_TS },
  { id: 'ts-counterexample', fixture: 'typescript/counterexample', load: ['cjs', 'dist/typescript/counterexample/src/app.js'], env: {}, probes: COUNTER('/svc') },
  { id: 'ts-counterexample-env-v2', fixture: 'typescript/counterexample', load: ['cjs', 'dist/typescript/counterexample/src/app.js'], env: { API_BASE: '/v2' }, probes: [['GET', '/v2/ping', '/v2/ping'], ['GET', '/svc/ping', '/svc/ping']] },
  { id: 'js-normal', fixture: 'javascript/normal', load: ['esm', 'javascript/normal/src/app.js'], env: {}, probes: NORMAL_JS },
  { id: 'js-counterexample', fixture: 'javascript/counterexample', load: ['esm', 'javascript/counterexample/src/app.js'], env: {}, probes: COUNTER('/svc') },
  { id: 'js-counterexample-env-v2', fixture: 'javascript/counterexample', load: ['esm', 'javascript/counterexample/src/app.js'], env: { API_BASE: '/v2' }, probes: [['GET', '/v2/ping', '/v2/ping'], ['GET', '/svc/ping', '/svc/ping']] },
];

async function loadApp([kind, rel], env, tag) {
  for (const k of ['API_BASE']) delete process.env[k];
  Object.assign(process.env, env);
  const file = path.join(here, rel);
  if (kind === 'cjs') { delete require.cache[file]; return require(file).default; }
  return (await import(`${pathToFileURL(file).href}?scenario=${tag}`)).default;
}

async function runScenario(s) {
  const app = await loadApp(s.load, s.env, s.id);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const probes = [];
  for (const [method, route, sample, auth = T] of s.probes) {
    const res = await fetch(`http://127.0.0.1:${port}${sample}`, { method, redirect: 'manual', headers: auth === T ? { 'x-token': 'ok' } : {} });
    await res.arrayBuffer();
    probes.push({ method, route, sample, auth, status: res.status });
  }
  await new Promise((r) => server.close(r));
  return { id: s.id, fixture: s.fixture, fixtureDigest: treeDigest(s.fixture), env: s.env, probes };
}

const scenarios = [];
for (const s of SCENARIOS) scenarios.push(await runScenario(s));
const out = { schema: 'bskel.http-scope-oracle/2', command: COMMAND, startEnv: START_ENV, lock: LOCK, framework: { name: 'express', version: require('express/package.json').version }, scenarios };
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
