// Runtime oracle for the Next.js scope record. For every scenario it copies the fixture to ./.work/<id>
// (the committed fixture bytes are never touched), runs the REAL `next build` there (exit code and the
// compiled route tables are recorded), then starts the production server in a fresh child process on an
// ephemeral 127.0.0.1 port and records the HTTP status of every candidate request. "exists" means a status
// other than 404 or 405. Output is deterministic JSON on stdout (no ports, paths, times, build ids). The
// probes cannot discover a served route that is not on the candidate list.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Hermetic start: remember which variable NAMES the caller passed in (the verifier compares them with the
// record's runEnv), then drop every one of them and pin PATH and NODE_ENV. Children get an explicit env too.
const START_ENV = Object.keys(process.env).sort();
const SERVE = process.argv[2] === '--serve';
// The internal --serve child receives the explicit environment built by childEnv() below and keeps exactly that.
if (!SERVE) {
  for (const k of START_ENV) delete process.env[k];
  process.env.PATH = '/usr/bin:/bin';
  process.env.NODE_ENV = 'production';
}
if (SERVE ? process.argv.length !== 5 : process.argv.length !== 2) { process.stderr.write(`usage: node oracle.mjs   (the child mode --serve <scenario id> <probes file> is internal), got: ${process.argv.slice(2).join(' ')}\n`); process.exit(2); }
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
  if (!files.length) throw new Error(`fixture ${rel} is empty or missing`);
  return sha(files.sort().map((f) => `${f}\n${sha(fs.readFileSync(path.join(here, rel, f)))}\n`).join(''));
}
const A = 'anon';
// [method, canonical route as the scanner writes it ({param} segments), URL requested, auth]
const NORMAL = [
  ['GET', '/portal/api/health', '/portal/api/health'], ['GET', '/portal/api/users', '/portal/api/users'], ['POST', '/portal/api/users', '/portal/api/users'],
  ['GET', '/portal/api/users/{id}', '/portal/api/users/42'], ['DELETE', '/portal/api/users/{id}', '/portal/api/users/42'],
  ['GET', '/portal/api/ping', '/portal/api/ping'], ['POST', '/portal/api/ping', '/portal/api/ping'], ['GET', '/portal/admin/stats', '/portal/admin/stats'],
  ['GET', '/api/health', '/api/health'], ['GET', '/portal/(admin)/admin/stats', '/portal/(admin)/admin/stats'], ['PUT', '/portal/api/users', '/portal/api/users'],
  ['HEAD', '/portal/api/health', '/portal/api/health'], ['OPTIONS', '/portal/api/health', '/portal/api/health'], ['GET', '/portal', '/portal'],
];
const COUNTER = [
  ['GET', '/portal/api/open', '/portal/api/open'], ['GET', '/portal/api/secure/data', '/portal/api/secure/data'], ['GET', '/portal/api/secure/data', '/portal/api/secure/data', A],
  ['GET', '/portal/api/items', '/portal/api/items'], ['POST', '/portal/api/items', '/portal/api/items'],
  ['GET', '/portal/sitemap.xml', '/portal/sitemap.xml'], ['GET', '/sitemap.xml', '/sitemap.xml'], ['GET', '/portal/v1/open', '/portal/v1/open'],
  ['GET', '/portal/api/legacy', '/portal/api/legacy'], ['POST', '/portal/api/legacy', '/portal/api/legacy'],
  ['GET', '/portal/api/files/{...path}', '/portal/api/files/a/b'], ['GET', '/api/open', '/api/open'], ['GET', '/portal', '/portal'],
];
const SCENARIOS = [
  { id: 'nextjs-normal', fixture: 'normal', env: {}, probes: NORMAL },
  { id: 'nextjs-counterexample', fixture: 'counterexample', env: {}, probes: COUNTER },
  { id: 'nextjs-counterexample-tenant-eu', fixture: 'counterexample', env: { TENANT: '-eu' }, probes: [['GET', '/portal-eu/api/open', '/portal-eu/api/open'], ['GET', '/portal/api/open', '/portal/api/open']] },
];
const WORK = path.join(here, '.work');
// HOME is a throw-away directory OUTSIDE the oracle directory: next build ignores a lock file whose directory would
// contain HOME, and then cannot find the installed next package.
let HOME = null;
// The explicit environment of every child: nothing is inherited.
const childEnv = (s) => ({ PATH: '/usr/bin:/bin', HOME, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', TENANT: '', ...s.env });

// child mode: serve one built scenario in-process, probe it, write the statuses to a file, exit.
if (SERVE) {
  const s = SCENARIOS.find((x) => x.id === process.argv[3]);
  if (!s) throw new Error(`unknown scenario id: ${process.argv[3]}`);
  if (!fs.existsSync(path.join(WORK, s.id, '.next'))) throw new Error(`scenario ${s.id} has not been built`);
  const { default: next } = await import('next');
  const app = next({ dev: false, dir: path.join(WORK, s.id), hostname: '127.0.0.1', port: 3000 });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const probes = [];
  for (const [method, route, url, auth = 'token'] of s.probes) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, redirect: 'manual', headers: auth === 'token' ? { 'x-token': 'ok' } : {} });
    await res.arrayBuffer();
    probes.push({ method, route, url, auth, status: res.status });
  }
  fs.writeFileSync(process.argv[4], JSON.stringify(probes));
  process.exit(0);
}

const nextBin = path.join(here, 'node_modules/next/dist/bin/next');
if (!fs.existsSync(nextBin)) throw new Error('next is not installed next to the oracle (run npm ci --ignore-scripts first)');
// a missing manifest throws; it is never recorded as null
const manifestKeys = (dir, name) => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.next/server', name), 'utf8'))).sort();
const cleanup = () => { fs.rmSync(WORK, { recursive: true, force: true }); if (HOME) fs.rmSync(HOME, { recursive: true, force: true }); };
const fail = (what, r) => { process.stderr.write(`${what} failed (exit ${r.status}, signal ${r.signal})\n${r.stdout ?? ''}\n${r.stderr ?? ''}\n`); cleanup(); process.exit(1); };
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-next-oracle-home-'));
const scenarios = [];
for (const s of SCENARIOS) {
  const work = path.join(WORK, s.id);
  fs.cpSync(path.join(here, s.fixture), work, { recursive: true });
  const env = childEnv(s);
  const build = spawnSync(process.execPath, [nextBin, 'build'], { cwd: work, env, encoding: 'utf8', timeout: 900000 });
  if (build.status !== 0) fail(`next build ${s.id}`, build);
  const probesFile = path.join(WORK, `${s.id}.probes.json`);
  const serve = spawnSync(process.execPath, [path.join(here, 'oracle.mjs'), '--serve', s.id, probesFile], { cwd: here, env, encoding: 'utf8', timeout: 300000 });
  if (serve.status !== 0) fail(`serve ${s.id}`, serve);
  scenarios.push({
    id: s.id, fixture: s.fixture, fixtureDigest: treeDigest(s.fixture), env: s.env,
    build: { exitCode: build.status, appPaths: manifestKeys(work, 'app-paths-manifest.json'), pages: manifestKeys(work, 'pages-manifest.json') },
    probes: JSON.parse(fs.readFileSync(probesFile, 'utf8')),
  });
}
cleanup();
const pkg = (name) => JSON.parse(fs.readFileSync(path.join(here, 'node_modules', name, 'package.json'), 'utf8')).version;
process.stdout.write(`${JSON.stringify({ schema: 'bskel.http-scope-oracle/2', command: COMMAND, startEnv: START_ENV, lock: LOCK, framework: { name: 'next', version: pkg('next'), packages: { react: pkg('react'), 'react-dom': pkg('react-dom') } }, scenarios }, null, 1)}\n`);
