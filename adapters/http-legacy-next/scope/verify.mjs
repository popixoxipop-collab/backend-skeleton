// Verifier for the seven HTTP "-01" target scope records (T11 Express x2, T12 NestJS/Fastify, T13
// Hono/Koa/Next.js). A record is a claim; this file RECOMPUTES everything the claim rests on:
// sha256 + byte count of every fixture/oracle/lock file, the framework pin from the committed lock
// file, the recorded runs' output hashes, the oracle facts, and the in-repo scanner's output on the
// fixtures (run live, twice). Nothing is read from the record to decide whether to check it, and a
// missing scanner, fixture or oracle is an error, never a skip. The recorded framework runs
// themselves are NOT replayed here (no installs in CI); the committed oracle output is the artifact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SCOPE_DIRS = ['adapters/http-legacy-next/scope', 'adapters/http-wave-a/scope', 'adapters/http-wave-bc/scope'];
export const REQUIRED_CATEGORIES = ['dynamic-route-factory', 'middleware-auth', 'generated-routes', 'deployment-prefix'];
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next']);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sorted = (xs) => [...new Set(xs)].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Canonical serialization for the seal: object keys sorted, no whitespace. The seal is the SHA-256 of the whole
// record except the seal field, so a prose edit that is not re-sealed fails. The seal only detects edits: every
// fact is still recomputed from files and code below, and a re-sealed lie is caught by those recomputations.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const sealOf = (rec) => { const { seal, ...rest } = rec; return sha256(canonical(rest)); };
// A repo-relative path is rejected only when it is empty, absolute, uses a backslash, or has an empty or ".." segment.
export const safeRel = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '..');
// The environment the run tool passes to every recorded step: nothing is inherited. <node-bin> and <scratch> stand for
// the Node binary directory and the scratch directory of the run. The oracle scripts drop even these on start.
export const RUN_ENV = { PATH: '<node-bin>:/usr/bin:/bin', HOME: '<scratch>/home', LANG: 'C', NEXT_TELEMETRY_DISABLED: '1', npm_config_update_notifier: 'false' };
const PLATFORM_INJECTED = ['__CF_USER_TEXT_ENCODING'];
// The only limit ids a record may carry, each bound to exactly one status.
export const LIMIT_STATUS = {
  'conformance-blocked': 'BLOCKED', 'promotion-held': 'BLOCKED',
  'candidate-list': 'UNKNOWN', 'false-route-with-unknown': 'UNKNOWN',
  'no-unknown-channel': 'UNSUPPORTED', 'fixture-scope': 'UNSUPPORTED',
  'not-run': 'NOT_RECORDED', 'no-ci-replay': 'NOT_RECORDED', 'single-platform': 'NOT_RECORDED', 'shared-run': 'NOT_RECORDED', 'upstream-no-lock': 'NOT_RECORDED', 'oracle-layer': 'NOT_RECORDED',
};
const OUTPUT_RE = /^(oracle-output(\.run2)?\.json|registry-[^/]+\.json)$/;

// "GET /v1/users/:id([0-9]+)/" -> "GET /v1/users/:id": verb upper-cased, param regexes and trailing slash dropped.
export function canonRoute(verb, p) {
  const route = p.replace(/(:[\w$]+)\([^)]*\)/g, '$1').replace(/(.)\/+$/, '$1');
  return `${verb.toUpperCase()} ${route || '/'}`;
}

export function walk(dir) {
  const out = [];
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) visit(next); } else out.push(next);
    }
  };
  visit('');
  return out.sort();
}

// The oracle binds its output to the fixture bytes it ran: sha256 over "path\nfilehash\n" of the sorted file list.
export const treeDigest = (files, readFile) => sha256([...files].sort().map((f) => `${f}\n${sha256(readFile(f))}\n`).join(''));

async function load(rel) {
  return import(pathToFileURL(path.join(repoRoot, rel)).href);
}

// Each runner returns { detected, endpoints: ["VERB /canonical/path"], unknowns: [strings] } for a fixture root,
// and registration(): the facts about the scanner's registration that the record must restate truthfully.
// Static adapters (Express legacy, Wave B/C leaves): scan(root, detection) -> modules[].controllers[].endpoints[]
// plus optional scanNotes (the unknown channel; the legacy Express adapters have none).
const PUBLISHED = { 'community-sample': 'scoped-community-sample', 'synthetic-only': 'synthetic-only-hold' };
// `pin` names the npm package whose version the repo's own profile pins (the profile evidence gives a version only).
function staticRunner(rel, { notes = false, profile = null, pin = null } = {}) {
  return {
    module: rel,
    emitsUnknownMarkers: notes,
    pinPackage: pin,
    async run(root) {
      const { adapter } = await load(rel);
      const detection = await adapter.detect(root);
      if (!detection) return { detected: false, endpoints: [], unknowns: [] };
      const result = await adapter.scan(root, detection);
      const endpoints = result.modules.flatMap((m) => m.controllers.flatMap((c) => c.endpoints.map((e) => canonRoute(e.verb, e.path))));
      return { detected: true, endpoints: sorted(endpoints), unknowns: notes ? (result.scanNotes ?? []) : [] };
    },
    async registration() {
      const { adapter } = await load(rel);
      const reg = { adapterId: adapter.id, contract: adapter.contract, specificity: adapter.specificity, verificationBasis: adapter.verificationBasis, capabilities: adapter.capabilities };
      if (profile) {
        const evidence = readJson(path.join(repoRoot, 'adapters/http-wave-bc/profile-evidence.json'));
        const entry = evidence.profiles.find((p) => p.id === profile);
        Object.assign(reg, { profileState: entry.state, promotionState: evidence.promotion_state, profilePin: entry.official_reference.package_version });
      }
      return reg;
    },
    published: (live) => PUBLISHED[live.verificationBasis] ?? 'unclassified',
  };
}

// Wave A leaves (NestJS, Fastify) are projectors over T04 facts with no scanner to run on a fixture, so their
// records are BLOCKED and are checked against the profile object and the repo tree instead of a scanner run.
const NOT_PRODUCER_DIRS = new Set(['node_modules', '.git', 'test', 'tests', 'fixtures', 'dist', '.next']);
// This verifier names the contracts it checks for (it is evidence tooling, not a producer), so it never counts as a hit.
const THIS_FILE = path.relative(repoRoot, fileURLToPath(import.meta.url)).split(path.sep).join('/');
function sourceFilesMentioning(needle) {
  const hits = [];
  const visit = (rel) => {
    for (const e of fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const next = path.posix.join(rel, e.name);
      if (e.isDirectory()) { if (!NOT_PRODUCER_DIRS.has(e.name)) visit(next); }
      else if (next !== THIS_FILE && /\.(mjs|cjs|js|ts)$/.test(e.name) && fs.readFileSync(path.join(repoRoot, next), 'utf8').includes(needle)) hits.push(next);
    }
  };
  visit('');
  return hits.sort();
}
function waveARunner(rel, profileName, { blockedCode, checkKinds, projection = null, factContract = null, pin = null }) {
  const profile = async () => (await load(rel))[profileName];
  return {
    module: rel,
    emitsUnknownMarkers: true,
    pinPackage: pin,
    blockedCode,
    checkKinds,
    async registration() {
      const p = await profile();
      return { profileId: p.id, state: p.state, registration: p.registration, productionDefault: p.productionDefault, runtimeTested: p.runtimeTested, t19Review: p.t19Review, supportedSyntax: p.supportedSyntax, versionPin: p.versionPin, profilePin: p.versionPin.framework ?? undefined };
    },
    published: () => 'blocked-upstream',
    // Each check recomputes one fact the BLOCKED reason rests on and returns it as a string.
    async blockedCheck(c, { rec, read }) {
      const p = await profile();
      // A check's target is declared by the record, so it is bound to what this runner actually executes or reads.
      if (c.kind === 'projection') {
        if (c.target !== projection) return `projection ${c.target} is not ${projection}`;
        const r = (await load(rel))[projection]();
        return `${r.status}:${r.unknowns.map((u) => u.code).join(',')}`;
      }
      if (c.kind === 'supported-syntax-count') return c.target === p.id ? String(p.supportedSyntax.length) : `profile ${c.target} is not ${p.id}`;
      if (c.kind === 'range-listing') {
        const listing = `${path.posix.dirname(rec.oracle.script)}/registry-range.json`, query = `${rec.framework.name}@${p.versionPin.declaredRange}`;
        if (c.target !== listing || rec.framework.rangeQuery !== query) return `listing ${c.target} and query ${rec.framework.rangeQuery} are not ${listing} and ${query}`;
        return `${p.versionPin.declaredRange} ${JSON.parse(read(c.target)).includes(rec.framework.version) ? 'includes' : 'excludes'} ${rec.framework.version}`;
      }
      if (c.kind === 'fact-contract-files') return c.target === factContract ? sourceFilesMentioning(c.target).join(',') : `contract ${c.target} is not ${factContract}`;
      return `unknown check kind ${c.kind}`;
    },
  };
}

export const RUNNERS = {
  'typescript-express': staticRunner('scanners/adapters/typescript-express.mjs'),
  'javascript-express': staticRunner('scanners/adapters/javascript-express.mjs'),
  'node-hono': staticRunner('adapters/http-wave-bc/node-hono/adapter.mjs', { notes: true, profile: 'node-hono', pin: 'hono' }),
  'node-fastify': waveARunner('adapters/http-wave-a/fastify.mjs', 'FASTIFY_PROFILE', { blockedCode: 'FASTIFY_UPSTREAM_RECEIVER_FACT_MISSING', checkKinds: ['projection', 'supported-syntax-count', 'range-listing'], projection: 'projectFastifyFacts' }),
  'typescript-nestjs': waveARunner('adapters/http-wave-a/nestjs.mjs', 'NESTJS_PROFILE', { blockedCode: 'NESTJS_STRUCTURE_FACT_PRODUCER_MISSING', checkKinds: ['fact-contract-files', 'supported-syntax-count'], factContract: 'bskel.internal.js-ts-structure/0', pin: '@nestjs/core' }),
  'node-koa': staticRunner('adapters/http-wave-bc/node-koa/adapter.mjs', { notes: true, profile: 'node-koa', pin: '@koa/router' }),
  'typescript-nextjs': staticRunner('adapters/http-wave-bc/typescript-nextjs/adapter.mjs', { notes: true, profile: 'typescript-nextjs', pin: 'next' }),
};

// A record's identity and track are bound to its runner, not only to the file name it was saved under.
const RUNNER_TRACK = { 'typescript-express': 'T11', 'javascript-express': 'T11', 'node-fastify': 'T12', 'typescript-nestjs': 'T12', 'node-hono': 'T13', 'node-koa': 'T13', 'typescript-nextjs': 'T13' };

const schemaFile = path.join(repoRoot, 'adapters/http-legacy-next/scope/target-scope.schema.json');
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(readJson(schemaFile));

export function loadRecords() {
  return SCOPE_DIRS.flatMap((dir) => fs.readdirSync(path.join(repoRoot, dir)).filter((f) => f.endsWith('.SCOPE.json')).sort()
    .map((f) => ({ file: `${dir}/${f}`, record: readJson(path.join(repoRoot, dir, f)) })));
}

// The oracle's runtime facts for one scenario: find a probe, and decide "exists" the same way everywhere.
const exists = (probe) => probe.status !== 404 && probe.status !== 405;
function probeFor(oracle, scenario, route, auth = 'token') {
  const [method, ...rest] = route.split(' ');
  const s = oracle.scenarios.find((x) => x.id === scenario);
  return s?.probes.find((p) => p.method === method && p.route === rest.join(' ') && (p.auth ?? 'token') === auth);
}

export function verdictFor(m, emitted, unknowns) {
  if (m.scannerShould.every((r) => emitted.includes(r))) return 'caught';
  if (m.unknownMarker && unknowns.some((u) => new RegExp(m.unknownMarker).test(u))) return 'left-unknown';
  return 'silent-miss';
}

// Everything derivable from the repo for a RUN-conformance record: the scanner's output on both
// fixtures (twice, for determinism), false routes against the oracle, and each must-catch verdict.
export async function evaluate(rec, oracle) {
  const runner = RUNNERS[rec.scanner.runner];
  if (!runner) throw new Error(`no runner ${rec.scanner.runner}`);
  const out = { emitted: {}, unknowns: {}, falseRoutes: {}, unprobed: {}, nondeterministic: [] };
  for (const kind of ['normal', 'counterexample']) {
    const root = path.join(repoRoot, rec.fixtures[kind].dir);
    const first = await runner.run(root);
    const second = await runner.run(root);
    if (!same(first, second)) out.nondeterministic.push(kind);
    out.detected = { ...out.detected, [kind]: first.detected };
    out.emitted[kind] = first.endpoints;
    out.unknowns[kind] = first.unknowns;
    const probes = first.endpoints.map((r) => [r, probeFor(oracle, rec.fixtures[kind].scenario, r)]);
    out.unprobed[kind] = probes.filter(([, p]) => !p).map(([r]) => r);
    out.falseRoutes[kind] = probes.filter(([, p]) => p && !exists(p)).map(([r]) => r);
  }
  out.verdicts = Object.fromEntries(rec.mustCatch.map((m) => [m.id, verdictFor(m, out.emitted.counterexample, out.unknowns.counterexample)]));
  out.counts = { caught: 0, 'left-unknown': 0, 'silent-miss': 0 };
  for (const v of Object.values(out.verdicts)) out.counts[v] += 1;
  return out;
}

// The steps a record's runs must contain, each with its exact argv, output binding and input set. Registry steps are
// derived from the manifest's direct dependencies, so a run without a dependency and a dependency without a run both fail.
const NPM_CACHE = ['--cache', '<scratch>/npm-cache'];
// The only build command: it is expected exactly when the oracle directory holds a tsconfig.json, whatever the record says.
const BUILD_ARGV = ['node_modules/.bin/tsc', '-p', 'tsconfig.json'];
function expectedSteps(rec, manifest, hasTsconfig) {
  const base = path.posix.dirname(rec.oracle.script);
  const lock = `${base}/package-lock.json`;
  const slug = (spec) => spec.replace(/[@/]/g, '_');
  const steps = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).map(([n, v]) => `${n}@${v}`).sort()
    .map((spec) => ({ id: `registry-${slug(spec)}`, spec, argv: ['npm', 'view', spec, 'name', 'version', 'dist.integrity', '--json', ...NPM_CACHE], inputs: 'none', out: { kind: 'stdout', file: `${base}/registry-${slug(spec)}.json` } }));
  if (rec.framework.rangeQuery) steps.push({ id: 'registry-range', argv: ['npm', 'view', rec.framework.rangeQuery, 'version', '--json', ...NPM_CACHE], inputs: 'none', out: { kind: 'stdout', file: `${base}/registry-range.json` } });
  steps.push({ id: 'install-1', argv: ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', ...NPM_CACHE], inputs: 'no-lock', out: { kind: 'file', file: lock } },
    { id: 'install-2', argv: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', ...NPM_CACHE], inputs: 'all', out: { kind: 'file', file: lock } });
  const build = (n) => (hasTsconfig ? [{ id: `build-${n}`, argv: BUILD_ARGV, inputs: 'all', out: { kind: 'stdout', file: null } }] : []);
  const oracleStep = (n) => ({ id: `oracle-${n}`, argv: ['node', path.posix.basename(rec.oracle.script)], inputs: 'all', out: { kind: 'stdout', file: rec.oracle.output } });
  steps.push(...build(1), oracleStep(1), ...build(2), oracleStep(2));
  return { base, steps, lock };
}

function checkRuns(rec, { read, err, checkFile }) {
  const base = path.posix.dirname(rec.oracle.script);
  let manifest;
  try { manifest = JSON.parse(read(`${base}/package.json`)); } catch { err(`${base}/package.json is not readable JSON`); return; }
  let disk = [];
  try { disk = walk(path.join(repoRoot, base)).filter((f) => !OUTPUT_RE.test(f)); } catch { err(`oracle directory ${base} cannot be listed`); }
  const hasTsconfig = disk.includes('tsconfig.json');
  if (!same(rec.oracle.buildArgv ?? null, hasTsconfig ? BUILD_ARGV : null)) err(`oracle.buildArgv ${JSON.stringify(rec.oracle.buildArgv)} is not what ${base} needs (${JSON.stringify(hasTsconfig ? BUILD_ARGV : null)})`);
  const { steps, lock } = expectedSteps(rec, manifest, hasTsconfig);
  const isReg = (id) => id.startsWith('registry-');
  const regActual = rec.runs.filter((r) => isReg(r.id)), tailActual = rec.runs.filter((r) => !isReg(r.id));
  const regWant = steps.filter((s) => isReg(s.id)), tailWant = steps.filter((s) => !isReg(s.id));
  // the evidence list is exactly the files this verifier reads or hashes for the record, each under its own role and path
  const wantEvidence = [['oracle-script', `${base}/oracle.mjs`], ['oracle-output', `${base}/oracle-output.json`], ['lock', lock], ['manifest', `${base}/package.json`], ...(hasTsconfig ? [['compiler-config', `${base}/tsconfig.json`]] : []), ...regWant.map((s) => ['registry-resolution', s.out.file])].map((e) => e.join(' ')).sort();
  if (!same(rec.evidenceFiles.map((f) => `${f.role} ${f.path}`).sort(), wantEvidence)) err(`evidenceFiles are not exactly [role path] ${JSON.stringify(wantEvidence)}`);
  if (rec.oracle.script !== `${base}/oracle.mjs` || rec.oracle.output !== `${base}/oracle-output.json`) err(`oracle.script ${rec.oracle.script} and oracle.output ${rec.oracle.output} are not ${base}/oracle.mjs and ${base}/oracle-output.json`);
  if (!rec.runs.slice(0, regActual.length).every((r) => isReg(r.id))) err('registry runs must come first');
  if (!same(regActual.map((r) => r.id).sort(), regWant.map((s) => s.id).sort())) err(`registry runs ${JSON.stringify(regActual.map((r) => r.id))} are not exactly the manifest's direct dependencies ${JSON.stringify(regWant.map((s) => s.id))}`);
  if (!same(tailActual.map((r) => r.id), tailWant.map((s) => s.id))) err(`run ids ${JSON.stringify(tailActual.map((r) => r.id))} are not the expected ordered steps ${JSON.stringify(tailWant.map((s) => s.id))}`);
  const depNames = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).sort();
  if (!same(depNames, rec.framework.packages.map((p) => p.name).sort())) err(`framework.packages must list exactly the manifest's direct dependencies ${JSON.stringify(depNames)}`);
  const digest = (list) => sha256(list.map((f) => `${f}\n${sha256(read(`${base}/${f}`))}\n`).join(''));
  const lockJson = JSON.parse(read(lock));
  for (const r of rec.runs) {
    const want = steps.find((s) => s.id === r.id);
    if (!want) { err(`unknown run id ${r.id}`); continue; }
    if (!same(r.argv, want.argv)) err(`run ${r.id}: argv ${JSON.stringify(r.argv)} is not the expected ${JSON.stringify(want.argv)} (exact token order)`);
    if (r.command !== r.argv.join(' ')) err(`run ${r.id}: command is not the argv joined by single spaces`);
    if (r.cwd !== base) err(`run ${r.id}: cwd ${r.cwd}, expected ${base}`);
    if (r.exitCode !== 0) err(`run ${r.id}: exit code ${r.exitCode}`);
    if (r.output.kind !== want.out.kind || r.output.file !== want.out.file) err(`run ${r.id}: output is ${r.output.kind} ${r.output.file}, expected ${want.out.kind} ${want.out.file}`);
    if (r.output.file) checkFile(`run ${r.id} output`, r.output.file, r.output);
    else if (r.output.bytes !== 0 || r.output.sha256 !== sha256(Buffer.alloc(0))) err(`run ${r.id} has no output file but is not empty stdout`);
    const list = { none: [], 'no-lock': disk.filter((f) => f !== 'package-lock.json'), all: disk }[want.inputs];
    try { if (r.inputsSha256 !== digest(list)) err(`run ${r.id}: inputsSha256 does not match the ${list.length} input files of ${base}`); } catch { err(`run ${r.id}: an input file of ${base} is unreadable`); }
    if (want.spec) {
      const at = want.spec.lastIndexOf('@'), name = want.spec.slice(0, at), version = want.spec.slice(at + 1);
      let got = null;
      try { got = JSON.parse(read(r.output.file)); } catch { err(`run ${r.id}: registry output is not JSON`); }
      const entry = lockJson.packages?.[`node_modules/${name}`];
      if (got && (got.name !== name || got.version !== version)) err(`run ${r.id}: registry answered ${got.name}@${got.version}`);
      if (got && (!entry || entry.version !== version || got['dist.integrity'] !== entry.integrity)) err(`run ${r.id}: registry integrity ${got['dist.integrity']} differs from the lock entry ${entry?.version} ${entry?.integrity}`);
    }
  }
  if (new Set(rec.runs.map((r) => `${r.node} ${r.platform}`)).size !== 1) err('all runs must share one Node version and platform');
  if (rec.runs.some((r, i) => i > 0 && r.at < rec.runs[i - 1].at)) err('run timestamps must not go backwards in the recorded order');
}

export async function verifyRecord(rec, { read = (rel) => fs.readFileSync(path.join(repoRoot, rel)) } = {}) {
  const errors = [];
  const err = (msg) => errors.push(`${rec.item ?? rec.target ?? '?'}: ${msg}`);
  if (!validateSchema(rec)) return validateSchema.errors.map((e) => `${rec.item ?? '?'}: schema ${e.instancePath} ${e.message}`);
  const fileSha = (rel) => { try { const b = read(rel); return { sha256: sha256(b), bytes: b.length }; } catch { return null; } };
  const checkFile = (what, rel, want) => {
    const got = fileSha(rel);
    if (!got) err(`${what} ${rel} is missing`);
    else if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) err(`${what} ${rel} drifted: recorded ${want.sha256.slice(0, 12)}/${want.bytes}B, recomputed ${got.sha256.slice(0, 12)}/${got.bytes}B`);
  };

  // 0. validate before recompute: path safety, then fail closed on any declared file that is missing, then the
  // closed vocabularies (limit ids and statuses, run environment) and the seal. Nothing below runs on a bad path.
  const files = [rec.scanner.module, rec.oracle.script, rec.oracle.output, ...rec.evidenceFiles.map((f) => f.path), ...rec.framework.packages.flatMap((p) => [p.lockFile, p.declared.file]), ...rec.runs.map((r) => r.output.file).filter(Boolean)];
  const dirs = [rec.fixtures.normal.dir, rec.fixtures.counterexample.dir, ...rec.runs.map((r) => r.cwd)];
  for (const k of ['normal', 'counterexample']) for (const f of rec.fixtures[k].files) files.push(`${rec.fixtures[k].dir}/${f.path}`);
  for (const m of rec.mustCatch) files.push(`${rec.fixtures.counterexample.dir}/${m.counterexample.file}`);
  for (const c of rec.conformance.checks ?? []) if (c.kind === 'range-listing') files.push(c.target);
  const unsafe = [...files, ...dirs].filter((p) => !safeRel(p));
  if (unsafe.length) { for (const p of unsafe) err(`unsafe path ${JSON.stringify(p)}`); return errors; }
  const missing = [...new Set(files)].filter((p) => !fileSha(p));
  if (missing.length) { for (const p of missing) err(`declared file ${p} is missing`); return errors; }
  if (rec.seal.sha256 !== sealOf(rec)) err(`seal does not match the record content (recomputed ${sealOf(rec).slice(0, 12)}): a changed record must be re-sealed`);
  const limitIds = rec.limits.map((l) => l.id);
  if (new Set(limitIds).size !== limitIds.length) err('duplicate limit ids');
  for (const l of rec.limits) if (LIMIT_STATUS[l.id] !== l.status) err(`limit ${l.id}: status ${l.status}, the registered status is ${LIMIT_STATUS[l.id] ?? '(none: unknown limit id)'}`);
  if (limitIds.includes('conformance-blocked') !== (rec.conformance.status === 'BLOCKED')) err('limit conformance-blocked must exist exactly when conformance is BLOCKED');
  if (limitIds.includes('not-run') !== (rec.claim.runtimeTested.notRun.length > 0)) err('limit not-run must exist exactly when runtimeTested.notRun is non-empty');
  if (canonical(rec.runEnv.variables) !== canonical(RUN_ENV)) err(`runEnv.variables differ from the run tool's environment: ${JSON.stringify(RUN_ENV)}`);
  if (rec.runEnv.platformInjected.some((n) => !PLATFORM_INJECTED.includes(n))) err(`runEnv.platformInjected may only name ${PLATFORM_INJECTED}`);

  // 1. policy: registration alone never reads as support; runtime claims need runs
  if (rec.claim.registrationAloneIsSupport !== false) err('claim.registrationAloneIsSupport must be false');
  const runner = RUNNERS[rec.scanner.runner];
  if (!runner) { err(`unknown scanner runner ${rec.scanner.runner}`); return errors; }
  const base = path.posix.dirname(rec.oracle.script);
  if (rec.scanner.module !== runner.module) err(`scanner.module ${rec.scanner.module} is not the module runner ${rec.scanner.runner} imports (${runner.module})`);
  if (rec.scanner.emitsUnknownMarkers !== runner.emitsUnknownMarkers) err(`scanner.emitsUnknownMarkers is ${rec.scanner.emitsUnknownMarkers}, runner ${rec.scanner.runner} reads the unknown channel: ${runner.emitsUnknownMarkers}`);
  if (rec.target !== `HTTP-${rec.scanner.runner}` || rec.item !== `${rec.target}-01`) err(`item ${rec.item} and target ${rec.target} do not name runner ${rec.scanner.runner}`);
  if (rec.track !== RUNNER_TRACK[rec.scanner.runner]) err(`track ${rec.track}, but runner ${rec.scanner.runner} belongs to ${RUNNER_TRACK[rec.scanner.runner]}`);
  const live = await runner.registration();
  if (!same(live, rec.claim.registration)) err(`claim.registration differs from the code: ${JSON.stringify(live)}`);
  if (rec.claim.published !== runner.published(live)) err(`claim.published ${rec.claim.published} contradicts the registration (${runner.published(live)})`);
  if (live.profilePin && !rec.framework.packages.some((p) => p.name === runner.pinPackage && p.version === live.profilePin)) err(`the repo's own profile pins ${runner.pinPackage}@${live.profilePin}, which is not among framework.packages`);
  const blocked = rec.conformance.status === 'BLOCKED';
  // only a projector runner (Fastify, NestJS) can be BLOCKED, and only a scanner runner can be RUN
  if (blocked !== ('blockedCode' in runner)) { err(`conformance is ${rec.conformance.status}, but runner ${rec.scanner.runner} ${'blockedCode' in runner ? 'is a projector with no scanner to run (BLOCKED only)' : 'runs a scanner (RUN only)'}`); return errors; }
  if (rec.claim.runtimeTested.scannerVsRuntimeCompared !== !blocked) err('runtimeTested.scannerVsRuntimeCompared must be true exactly when conformance ran');
  if (blocked && !rec.conformance.reason) err('BLOCKED conformance needs an exact reason');

  // 2. files: fixtures are complete directory listings, shared evidence files are individually pinned
  for (const kind of ['normal', 'counterexample']) {
    const fx = rec.fixtures[kind];
    let onDisk = [];
    try { onDisk = walk(path.join(repoRoot, fx.dir)); } catch { err(`fixture dir ${fx.dir} is missing`); }
    if (!same(onDisk, fx.files.map((f) => f.path))) err(`fixture ${kind} file list differs from disk: ${JSON.stringify(onDisk)}`);
    for (const f of fx.files) checkFile(`fixture ${kind}`, `${fx.dir}/${f.path}`, f);
  }
  for (const f of rec.evidenceFiles) checkFile(`evidence(${f.role})`, f.path, f);

  // 3. pins: recomputed from the oracle directory's own committed lock file and package.json (not from paths the record names)
  const lockPath = `${base}/package-lock.json`, manifestPath = `${base}/package.json`;
  let lockRaw = Buffer.alloc(0);
  const lock = (() => { try { lockRaw = read(lockPath); return JSON.parse(lockRaw); } catch { return null; } })();
  const manifest = (() => { try { return JSON.parse(read(manifestPath)); } catch { return null; } })();
  if (!lock || !manifest) err(`${lockPath} and ${manifestPath} must be readable JSON`);
  if (Object.values(lock?.packages ?? {}).some((e) => e.resolved && !e.resolved.startsWith('https://registry.npmjs.org/'))) err(`${lockPath} has an entry that does not resolve from https://registry.npmjs.org/ (framework.registry is ${rec.framework.registry})`);
  for (const p of rec.framework.packages) {
    if (p.lockFile !== lockPath || p.declared.file !== manifestPath) err(`pin ${p.name}: lockFile ${p.lockFile} and declared.file ${p.declared.file} are not the oracle directory's ${lockPath} and ${manifestPath}`);
    if (p.lockKey !== `node_modules/${p.name}`) err(`pin ${p.name}: lockKey ${p.lockKey} is not node_modules/${p.name}`);
    const entry = lock?.packages?.[`node_modules/${p.name}`];
    if (!entry) err(`lock entry node_modules/${p.name} not found in ${lockPath}`);
    else if (entry.version !== p.version || entry.integrity !== p.integrity) err(`pin ${p.name}: lock has ${entry.version} ${entry.integrity}, record has ${p.version} ${p.integrity}`);
    if (manifest && manifest[p.declared.section]?.[p.name] !== p.version) err(`${manifestPath} does not declare ${p.name} at exactly ${p.version}`);
  }
  if (!rec.framework.packages.some((p) => p.name === rec.framework.name && p.version === rec.framework.version)) err('framework.name/version must be one of framework.packages');

  // 4. runs: exact step list, argv tokens in order, cwd, exit codes, output and input hashes, registry JSON vs lock
  checkRuns(rec, { read, err, checkFile });
  if (!same(rec.oracle.runIds, ['oracle-1', 'oracle-2'])) err('oracle.runIds must be exactly oracle-1, oracle-2');
  const oracleRuns = rec.oracle.runIds.map((id) => rec.runs.find((r) => r.id === id));
  if (oracleRuns.some((r) => !r)) { err('oracle.runIds names an unknown run'); return errors; }
  if (oracleRuns.some((r) => r.exitCode !== 0)) err('an oracle run has a non-zero exit code');
  if (oracleRuns.some((r) => r.output.file !== rec.oracle.output || r.output.sha256 !== oracleRuns[0].output.sha256)) err('oracle runs must hash to the same committed output file (determinism)');
  if (oracleRuns.length < 2) err('determinism needs at least two oracle runs');
  if (rec.claim.runtimeTested.frameworkOracleRun !== true) err('runtimeTested.frameworkOracleRun must be true when oracle runs are recorded');

  // 5. oracle facts
  let oracle;
  try { oracle = JSON.parse(read(rec.oracle.output)); } catch { err('oracle output is not readable JSON'); return errors; }
  if (oracle.framework.name !== rec.framework.name || oracle.framework.version !== rec.framework.version) err(`oracle ran ${oracle.framework.name}@${oracle.framework.version}, not the pinned ${rec.framework.name}@${rec.framework.version}`);
  // every other package version the oracle read from node_modules (react, a router, Nest packages) is the pinned one too
  const reported = [...Object.entries(oracle.framework.packages ?? {}), ...(oracle.framework.router ? [[oracle.framework.router.name, oracle.framework.router.version]] : [])];
  for (const [name, version] of reported) if (rec.framework.packages.find((p) => p.name === name)?.version !== version) err(`oracle ran ${name}@${version}, which is not the pinned version`);
  // the oracle output is bound to the exact command, lock file and environment names it ran with
  const lockPackages = Object.keys(lock?.packages ?? {}).length - 1;
  if (oracle.schema !== 'bskel.http-scope-oracle/2') err(`oracle output schema is ${oracle.schema}`);
  if (!same(oracle.command, ['node', path.posix.basename(rec.oracle.script)])) err(`oracle output was produced by ${JSON.stringify(oracle.command)}`);
  if (oracle.lock?.file !== 'package-lock.json' || oracle.lock.sha256 !== sha256(lockRaw) || oracle.lock.packages !== lockPackages || !(oracle.lock.installed > 0 && oracle.lock.installed <= lockPackages)) err(`oracle output is bound to another lock: ${JSON.stringify(oracle.lock)}`);
  if (!same((oracle.startEnv ?? []).filter((n) => !rec.runEnv.platformInjected.includes(n)), Object.keys(rec.runEnv.variables).sort())) err(`oracle saw environment names ${JSON.stringify(oracle.startEnv)}, runEnv says ${JSON.stringify(Object.keys(rec.runEnv.variables).sort())} (+ platform ${JSON.stringify(rec.runEnv.platformInjected)})`);
  for (const kind of ['normal', 'counterexample']) {
    const fx = rec.fixtures[kind];
    const s = oracle.scenarios.find((x) => x.id === fx.scenario);
    if (!s) { err(`oracle has no scenario ${fx.scenario}`); continue; }
    if (fx.dir !== `${base}/${s.fixture}`) err(`oracle scenario ${s.id} ran ${s.fixture}, the record points at ${fx.dir}`);
    try {
      const digest = treeDigest(fx.files.map((f) => f.path), (f) => read(`${fx.dir}/${f}`));
      if (s.fixtureDigest !== digest) err(`oracle scenario ${s.id} ran other fixture bytes: oracle digest ${String(s.fixtureDigest).slice(0, 12)}, recomputed ${digest.slice(0, 12)}`);
    } catch { /* a missing file is already reported by the fixture check above */ }
  }
  const covered = new Set(rec.mustCatch.map((m) => m.category));
  for (const c of REQUIRED_CATEGORIES) if (!covered.has(c)) err(`mustCatch lacks category ${c}`);
  const mustIds = new Set(rec.mustCatch.map((m) => m.id));
  for (const u of rec.unsupported) for (const id of u.mustCatch) if (!mustIds.has(id)) err(`unsupported ${u.id} cites unknown mustCatch ${id}`);
  const ownScenarios = new Set(oracle.scenarios.filter((x) => [rec.fixtures.normal.dir, rec.fixtures.counterexample.dir].includes(`${base}/${x.fixture}`)).map((x) => x.id));
  for (const m of rec.mustCatch) {
    const text = (() => { try { return read(`${rec.fixtures.counterexample.dir}/${m.counterexample.file}`).toString('utf8'); } catch { return null; } })();
    if (text === null || !text.includes(m.counterexample.contains)) err(`${m.id}: counterexample snippet not found in ${m.counterexample.file}`);
    for (const t of m.truth) {
      if (!ownScenarios.has(t.scenario)) err(`${m.id}: truth cites scenario ${t.scenario}, which does not run this record's fixtures`);
      const p = probeFor(oracle, t.scenario, t.route, t.auth);
      if (!p) err(`${m.id}: oracle has no probe ${t.scenario} ${t.route} ${t.auth ?? 'token'}`);
      else if ((t.status !== undefined && p.status !== t.status) || (t.exists !== undefined && exists(p) !== t.exists)) err(`${m.id}: oracle says ${t.route} -> ${p.status}, record says ${JSON.stringify(t)}`);
    }
  }

  // 6. conformance: live scanner vs oracle (RUN), or the blocked checks (BLOCKED)
  if (blocked) {
    if (rec.mustCatch.some((m) => m.expected !== 'not-evaluated')) err('BLOCKED conformance cannot carry scanner verdicts');
    if (rec.conformance.code !== runner.blockedCode) err(`BLOCKED code ${rec.conformance.code} is not the one runner ${rec.scanner.runner} is blocked on (${runner.blockedCode})`);
    if (!same(rec.conformance.checks.map((c) => c.kind), runner.checkKinds)) err(`BLOCKED checks ${JSON.stringify(rec.conformance.checks.map((c) => c.kind))} are not exactly ${JSON.stringify(runner.checkKinds)}`);
    for (const r of rec.conformance.oracleConfirmedNormal) {
      const p = probeFor(oracle, rec.fixtures.normal.scenario, r);
      if (!p || !exists(p)) err(`oracleConfirmedNormal ${r} is not served in the oracle output`);
    }
    const served = (oracle.scenarios.find((x) => x.id === rec.fixtures.normal.scenario)?.probes ?? []).filter((p) => exists(p) && (p.auth ?? 'token') === 'token').map((p) => `${p.method} ${p.route}`);
    if (!same(sorted(served), sorted(rec.conformance.oracleConfirmedNormal))) err(`oracleConfirmedNormal must list exactly the routes the oracle saw served: ${JSON.stringify(sorted(served))}`);
    for (const s of rec.supported) for (const r of s.emits) if (!rec.conformance.oracleConfirmedNormal.includes(r)) err(`supported ${s.id}: ${r} is not oracle-confirmed`);
    for (const c of rec.conformance.checks) {
      const got = await runner.blockedCheck(c, { rec, read });
      if (got !== c.expect) err(`blocked check ${c.kind} ${c.target}: expected ${c.expect}, observed ${got}`);
    }
    return errors;
  }
  const ev = await evaluate(rec, oracle);
  for (const kind of ['normal', 'counterexample']) {
    if (!ev.detected[kind]) err(`scanner did not detect the ${kind} fixture (is ripgrep installed?)`);
    if (ev.unprobed[kind].length) err(`${kind}: scanner emitted routes the oracle never probed: ${ev.unprobed[kind]}`);
    if (!same(ev.emitted[kind], rec.conformance.emitted[kind])) err(`${kind}: scanner now emits ${JSON.stringify(ev.emitted[kind])}`);
    if (!same(ev.falseRoutes[kind], rec.conformance.falseRoutes[kind])) err(`${kind}: false routes now ${JSON.stringify(ev.falseRoutes[kind])}`);
  }
  if (ev.nondeterministic.length) err(`scanner output differs between two runs on ${ev.nondeterministic}`);
  for (const m of rec.mustCatch) {
    if (ev.verdicts[m.id] !== m.expected) err(`${m.id}: verdict is ${ev.verdicts[m.id]}, record says ${m.expected}`);
    if (m.unknownMarker && !ev.unknowns.counterexample.some((u) => new RegExp(m.unknownMarker).test(u))) err(`${m.id}: the scanner no longer reports an unknown matching /${m.unknownMarker}/`);
    for (const r of m.scannerEmitsInstead) if (!ev.emitted.counterexample.includes(r) || !ev.falseRoutes.counterexample.includes(r)) err(`${m.id}: ${r} is not a live false route`);
  }
  if (!same(ev.counts, rec.conformance.verdictCounts)) err(`verdict counts are ${JSON.stringify(ev.counts)}`);
  // every supported construct is proven by routes the scanner emits AND the live framework serves
  for (const s of rec.supported) for (const r of s.emits) {
    const p = probeFor(oracle, rec.fixtures.normal.scenario, r);
    if (!ev.emitted.normal.includes(r) || !p || !exists(p)) err(`supported ${s.id}: ${r} is not emitted-and-served`);
  }
  if (!same(sorted(rec.supported.flatMap((s) => s.emits)), ev.emitted.normal)) err('supported[].emits must account for exactly the routes emitted on the normal fixture');
  return errors;
}
