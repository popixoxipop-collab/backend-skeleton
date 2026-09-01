#!/usr/bin/env node
// D-typescript-express-provider (G5): the other half of java-compile-smoke.mjs/python-import-
// smoke.mjs's own precedent -- proof that `bskel handles emit`'s generated TypeScript actually
// TYPE-CHECKS against real TypeORM/Express types, not just that it runs (test/handles-typescript-
// codec.test.mjs already proves codec.ts.tmpl's own runtime behavior; that alone can't catch a
// generated import pointing at a name that doesn't really exist, or a type mismatch like a
// resolver's fetch() disagreeing with TypeORM's real findOne() overload set). Unlike Python
// (dynamically typed -- a real import already proves the meaningful thing), TypeScript's whole
// value proposition IS its compiler, so this needs a real `tsc --noEmit`, not a lighter substitute.
//
// Genuinely cheaper to set up than the Java/Python equivalents: no JVM/Gradle, no Python venv --
// just `npm install` into the scratch repo's own node_modules (never a new backend-skeleton
// devDependency), something this whole CLI already depends on. Runs the full gated workflow
// against test/fixtures/typescript-express/ in a scratch copy, same shape as java-compile-
// smoke.mjs/python-import-smoke.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bskel, makeFail, establishThroughContract, REPO_ROOT } from './_smoke-lib.mjs';

const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'typescript-express');
const FEATURE_ID = '001-user-management';

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

const fail = makeFail('typescript-typecheck-smoke');

console.log('typescript-typecheck-smoke: copying fixture to a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-typecheck-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\nnode_modules/\n');

sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: typescript-typecheck-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-typecheck-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

console.log('typescript-typecheck-smoke: preflight -> feature init -> scan -> disposition -> cross-feature-check -> handles emit...');
// No OpenAPI oracle exists for plain Express (D-typescript-express-provider) -- contract emit is
// out of scope for this smoke script, same as test/typescript-express-handles.test.mjs's own e2e
// fixture forces past it. This script's only concern is real type-checking of generated codegen.
establishThroughContract(scratch, fail, {
	featureId: FEATURE_ID, slug: 'user-management', terms: 'user', mode: 'extend', note: 'typescript-typecheck-smoke',
	contractStep: { kind: 'force', reason: 'handles-only smoke test, no OpenAPI oracle for this ecosystem' },
});

let r = bskel(['handles', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--json'], scratch);
if (r.code !== 0) fail(`handles emit: ${r.stderr || r.stdout}`);
let emitResult;
try {
	emitResult = JSON.parse(r.stdout);
} catch {
	fail(`handles emit produced no parseable JSON: ${r.stdout}`);
}
if (!emitResult.written.includes('backend/src/handles/resolvers/user.ts')) {
	fail(`expected backend/src/handles/resolvers/user.ts to be written -- got ${JSON.stringify(emitResult.written)}`);
}

const backendDir = path.join(scratch, 'backend');
console.log('typescript-typecheck-smoke: npm install (typescript/express/typeorm/reflect-metadata/@types, one call, into the SCRATCH repo\'s own node_modules)...');
try {
	sh('npm', ['install', '--no-audit', '--no-fund'], backendDir, { quiet: true });
} catch (err) {
	fail(`npm install failed: ${err.stderr || err.message}`);
}

console.log('typescript-typecheck-smoke: running a real `npx tsc --noEmit` against the emitted tree...');
try {
	sh('npx', ['tsc', '--noEmit'], backendDir, { quiet: true });
} catch (err) {
	fail(`tsc --noEmit found real type errors in generated code:\n${err.stdout || err.stderr || err.message}`);
}

// D-typescript-express-provider slice-4 correction: the emitted router.ts/codec.ts/registry.ts
// (unconditional infra, zero {{VAR}} substitutions -- rendered byte-identical to their own
// templates) already implement a generic, kind-agnostic GET pointer-walk, same as java-spring's
// HandleController.java.tmpl (verified live by java-integration-smoke.mjs) and python-fastapi's
// router.py.tmpl (verified live by python-integration-smoke.mjs) -- but until this correction,
// typescript-express shipped with NO runtime test proving it. A real TypeORM-backed resolver needs
// a live Postgres this provider deliberately has no db-introspect-equivalent scope for, so this
// registers a hand-built fake resolver directly against the REAL emitted registry.ts/router.ts
// (not a stand-in copy) -- the router/codec logic under test doesn't know or care where fetch()'s
// data came from, only whether it walks a JSON Pointer correctly and projects through toPublic().
// `express` is already in this scratch repo's own node_modules from the npm install above -- no
// new dependency, no new network cost. Runs via a REAL `tsc` compile (not `--experimental-strip-
// types`) -- found live, not assumed: this project's own generated relative imports are
// deliberately extensionless (`from './codec'`, matching moduleResolution:"node" convention every
// other file in this provider already uses), which `tsc`'s own resolver accepts but Node's native
// ESM loader under type-stripping does NOT (it requires an explicit extension on every relative
// specifier) -- confirmed by a real `MODULE_NOT_FOUND` when first tried. This isn't a bug to fix in
// the templates: TypeORM's own `@Entity()`/`@PrimaryGeneratedColumn()` decorators require
// `emitDecoratorMetadata`, a real compile-time transform type-stripping alone can never perform, so
// no realistic deployment of a TypeORM app runs via bare type-stripping anyway -- a real `tsc`
// compile is the correct, realistic thing to test against.
const HTTP_DRIVER_SOURCE = `
import express from 'express';
import http from 'node:http';
import { register } from './registry';
import { router } from './router';
import { encodeHandle } from './codec';

async function main() {
  const FAKE_UUID = 'e957347e-3794-4c71-92a8-cec75dec1c97';
  register({
    type: 'Thing',
    async fetch(uid: string) { return { id: uid, name: 'Ann', secret: 'hidden' }; },
    checkAccess(_obj: unknown) {},
    patchField(_obj: unknown, _pointer: string, _value: unknown) {},
    toPublic(obj: unknown) { const o = obj as any; return { id: o.id, name: o.name }; },
  });

  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = \`http://127.0.0.1:\${port}\`;

  async function check(label: string, url: string, expectedStatus: number, assertBody?: (body: any) => void) {
    const res = await fetch(url);
    if (res.status !== expectedStatus) {
      throw new Error(\`\${label}: expected status \${expectedStatus}, got \${res.status}\`);
    }
    if (assertBody) assertBody(await res.json());
  }

  const resourceHandle = encodeHandle('r', 'Thing', FAKE_UUID, null);
  const fieldHandle = encodeHandle('f', 'Thing', FAKE_UUID, '/name');
  const missingFieldHandle = encodeHandle('f', 'Thing', FAKE_UUID, '/nope');

  await check('resource-level GET (kind=r)', \`\${base}/handles/\${resourceHandle}\`, 200, (body) => {
    if (body.name !== 'Ann') throw new Error(\`expected name "Ann", got \${JSON.stringify(body)}\`);
    if ('secret' in body) throw new Error('toPublic() leaked the secret field -- resolver should only ever project through toPublic()');
  });

  await check('field-level GET (kind=f, real pointer /name)', \`\${base}/handles/\${fieldHandle}\`, 200, (body) => {
    if (body !== 'Ann') throw new Error(\`expected field value "Ann", got \${JSON.stringify(body)}\`);
  });

  await check('field-level GET (kind=f, missing pointer /nope)', \`\${base}/handles/\${missingFieldHandle}\`, 404);

  server.close();
  console.log('typescript-typecheck-smoke: real HTTP pointer-walk round trip PASSED (resource GET, field GET, missing-pointer 404)');
}

main().catch((err) => { console.error(err); process.exit(1); });
`;

console.log('typescript-typecheck-smoke: real HTTP round trip -- compiling the emitted tree with a real `tsc` (noEmit overridden) and running the compiled output (kind=r whole-resource, kind=f real pointer, kind=f missing pointer -> 404)...');
const httpDriverPath = path.join(backendDir, 'src', 'handles', 'http-test-driver.ts');
fs.writeFileSync(httpDriverPath, HTTP_DRIVER_SOURCE);
const distDir = path.join(backendDir, 'dist-smoke-test');
try {
	sh('npx', ['tsc', '--outDir', distDir, '--noEmit', 'false'], backendDir, { quiet: true });
} catch (err) {
	fail(`real tsc compile (for the HTTP round trip) failed:\n${err.stdout || err.stderr || err.message}`);
}
try {
	sh('node', [path.join(distDir, 'handles', 'http-test-driver.js')], backendDir, { quiet: true });
} catch (err) {
	fail(`real HTTP pointer-walk round trip failed:\n${err.stdout || err.stderr || err.message}`);
}

console.log('typescript-typecheck-smoke: HANDLES phase PASSED (type-check + GET pointer-walk round trip).');

// D-runtime-conformance-receipts (typescript-express port): the real HTTP-execution proof for the
// response-body-capture design (res.json patch + res.on('finish', ...) status read) -- this
// project's own established discipline of verifying via real execution, not just reading source.
// Reuses the SAME scratch repo/node_modules as the handles phase above (a deliberate, more
// thorough choice than a second fresh checkout -- it also proves observe and handles genuinely
// coexist in one real repo, matching D-runtime-conformance-receipts's own "orthogonal capabilities"
// framing) rather than paying a second `npm install`.
console.log('typescript-typecheck-smoke: contract emit --openapi-file -> observe emit...');
// The literal Express-colon-syntax path key, not OpenAPI-standard {id} -- contracts/openapi.mjs's
// reconciliation is pure exact-string matching with zero :id <-> {id} translation (confirmed
// live), so a standards-shaped document would never match this scanned route at all. A real
// `responses.200` schema (not empty) is required to get a non-trivial `response`/`statuses`
// projection to actually exercise below -- an empty `responses: {}` (as used by the CLI test file,
// which only needs written-file-shape assertions) would make every response check vacuously pass.
const openApiPath = path.join(scratch, 'openapi.json');
fs.writeFileSync(openApiPath, JSON.stringify({
	openapi: '3.1.0',
	paths: {
		'/v1/users/:id([0-9]+)': {
			get: {
				operationId: 'users-show',
				responses: {
					200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
				},
			},
		},
	},
}));
// Re-run scan/disposition before contract emit -- the scan gate goes stale between the handles
// phase above and here (found live, not assumed: `bskel contract emit` refused with "scan gate is
// stale" the first time this was run without this re-check), matching the same re-establish
// pattern this project's own D-security-7 test / test/handles-plan-fixture.test.mjs's resolvers_
// index.ts tests already use after an intervening write.
r = bskel(['scan', '--feature', FEATURE_ID, '--terms', 'user'], scratch);
if (![0, 3].includes(r.code)) fail(`re-scan: exit ${r.code}: ${r.stderr || r.stdout}`);
r = bskel(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'extend', '--note', 'observe-phase'], scratch);
if (r.code !== 0) fail(`re-disposition: ${r.stderr || r.stdout}`);

r = bskel(['contract', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--openapi-file', openApiPath, '--path-prefix', '/v1'], scratch);
if (r.code !== 0) fail(`contract emit --openapi-file: ${r.stderr || r.stdout}`);

r = bskel(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--json'], scratch);
if (r.code !== 0) fail(`observe emit: ${r.stderr || r.stdout}`);
let observeResult;
try {
	observeResult = JSON.parse(r.stdout);
} catch {
	fail(`observe emit produced no parseable JSON: ${r.stdout}`);
}
const expectedObserveFiles = ['backend/src/observe/contractCheck.ts', 'backend/src/observe/observedSchema.ts', 'backend/src/observe/observeContract.ts', 'backend/src/observe/schemas/001-user-management.observed-schema.json'];
for (const f of expectedObserveFiles) {
	if (!observeResult.written.includes(f)) fail(`observe emit: expected ${f} in written, got ${JSON.stringify(observeResult.written)}`);
}
if (!fs.existsSync(path.join(backendDir, 'src', 'handles', 'router.ts'))) {
	fail('observe emit must never remove/touch anything handles emit owns -- backend/src/handles/router.ts is gone');
}

// Real, structural, pre-existing gap this port surfaced but does not fix (out of scope --
// contracts/emit.mjs's own pathParamsSchema() is shared by all 3 adapters, only recognizes
// OpenAPI-style {name} segments, never Express's own :name syntax): pathParams.required is always
// empty for a real typescript-express contract, so a "bad path param" violation scenario is not
// achievable here -- see the Update note in D-runtime-conformance-receipts in DECISIONS.md.
const observedSchemaPath = path.join(backendDir, 'src', 'observe', 'schemas', '001-user-management.observed-schema.json');
const observedSchema = JSON.parse(fs.readFileSync(observedSchemaPath, 'utf8'));
if (!observedSchema.operations['users-show'] || observedSchema.operations['users-show'].response.required.join(',') !== 'id,name') {
	fail(`observe emit: expected users-show.response.required = [id, name], got ${JSON.stringify(observedSchema.operations['users-show'])}`);
}

// D-runtime-conformance-receipts: the actual HTTP round trip -- builds a real Express app using
// the REAL generated observeContract('users-show') middleware, captures receipts via
// setReceiptSink instead of the default process.stdout.write, and proves: (1) a conformant
// response produces zero violations; (2) a response missing a required field is delivered to the
// client COMPLETELY UNALTERED (best-effort, non-interference) while the receipt correctly flags
// it, and the raw payload never appears substring-wise in any violation message (Decision A, the
// TS equivalent of java's/python's own adversarial-battery proof); (3) an undocumented status
// (404, not in the observed ["200"]) produces a /status violation; (4) a handler that calls
// res.send(<string>) instead of res.json(...) still gets a receipt with the real captured status,
// but ZERO response-body violations -- proving "uncaptured, not guessed" for real, not just by
// reading source.
const OBSERVE_HTTP_DRIVER_SOURCE = `
import express from 'express';
import http from 'node:http';
import { observeContract, setReceiptSink } from './observeContract';

async function main() {
  const receipts: any[] = [];
  setReceiptSink((line: string) => { receipts.push(JSON.parse(line)); });

  const app = express();
  app.use(express.json());
  // D-openapi-path-params: real :id segments now, matching the fixture's own route
  // (:id([0-9]+)) -- once path-param names are extracted for real (this item), the observed
  // schema's heuristic UUID-shape guess for an "id"-suffixed name actually runs, so scenarios
  // (1)-(4) below pass a real UUID-shaped id to avoid an UNINTENDED /pathParams/id pattern
  // violation contaminating their own assertions; scenario (5) deliberately passes a non-UUID id
  // to prove that check fires for real.
  app.get('/v1/users/:id/conformant', observeContract('users-show'), (req, res) => {
    res.json({ id: 'u-1', name: 'Ann' });
  });
  app.get('/v1/users/:id/missing-field', observeContract('users-show'), (req, res) => {
    res.json({ id: 'u-2' }); // missing "name", the required field
  });
  app.get('/v1/users/:id/bad-status', observeContract('users-show'), (req, res) => {
    res.status(404).json({ id: 'u-3', name: 'Ghost' });
  });
  app.get('/v1/users/:id/raw-string', observeContract('users-show'), (req, res) => {
    res.send('a raw string response, never JSON');
  });
  app.get('/v1/users/:id/bad-param', observeContract('users-show'), (req, res) => {
    res.json({ id: 'u-5', name: 'Bob' });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = \`http://127.0.0.1:\${port}\`;
  const UUID_ID = '11111111-1111-1111-1111-111111111111';

  async function waitForReceipt(before: number): Promise<any> {
    for (let i = 0; i < 50; i++) {
      if (receipts.length > before) return receipts[receipts.length - 1];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no receipt observed within 500ms -- res.on(finish) never fired?');
  }

  // (1) conformant
  {
    const before = receipts.length;
    const res = await fetch(\`\${base}/v1/users/\${UUID_ID}/conformant\`);
    const body = await res.json();
    if (res.status !== 200 || body.name !== 'Ann') throw new Error(\`conformant: unexpected response \${res.status} \${JSON.stringify(body)}\`);
    const receipt = await waitForReceipt(before);
    if (receipt.violations.length !== 0) throw new Error(\`conformant: expected zero violations, got \${JSON.stringify(receipt.violations)}\`);
  }

  // (2) missing required field -- client unaffected, receipt flags it, no leaked value
  {
    const before = receipts.length;
    const res = await fetch(\`\${base}/v1/users/\${UUID_ID}/missing-field\`);
    const body = await res.json();
    if (res.status !== 200 || body.id !== 'u-2' || 'name' in body) throw new Error(\`missing-field: client response was altered -- \${res.status} \${JSON.stringify(body)}\`);
    const receipt = await waitForReceipt(before);
    const hit = receipt.violations.find((v: any) => v.pointer === '/body/name' && v.keyword === 'required');
    if (!hit) throw new Error(\`missing-field: expected a /body/name required violation, got \${JSON.stringify(receipt.violations)}\`);
    for (const v of receipt.violations) {
      if (JSON.stringify(v).includes('u-2')) throw new Error(\`Decision A violation: an observed value leaked into a violation message -- \${JSON.stringify(v)}\`);
    }
  }

  // (3) undocumented status
  {
    const before = receipts.length;
    const res = await fetch(\`\${base}/v1/users/\${UUID_ID}/bad-status\`);
    if (res.status !== 404) throw new Error(\`bad-status: expected client to see real 404, got \${res.status}\`);
    const receipt = await waitForReceipt(before);
    const hit = receipt.violations.find((v: any) => v.pointer === '/status' && v.keyword === 'status');
    if (!hit) throw new Error(\`bad-status: expected a /status violation, got \${JSON.stringify(receipt.violations)}\`);
  }

  // (4) res.send(<string>) -- response body never captured, never guessed
  {
    const before = receipts.length;
    const res = await fetch(\`\${base}/v1/users/\${UUID_ID}/raw-string\`);
    const text = await res.text();
    if (text !== 'a raw string response, never JSON') throw new Error(\`raw-string: client response was altered -- \${JSON.stringify(text)}\`);
    const receipt = await waitForReceipt(before);
    if (receipt.status !== 200) throw new Error(\`raw-string: expected the real captured status 200, got \${receipt.status}\`);
    const bodyViolations = receipt.violations.filter((v: any) => v.pointer.startsWith('/body'));
    if (bodyViolations.length !== 0) throw new Error(\`raw-string: expected zero response-body violations (uncaptured, not guessed), got \${JSON.stringify(bodyViolations)}\`);
  }

  // (5) D-openapi-path-params: a bad (non-UUID-shaped) path param -- the observed schema's
  // heuristic guesses a UUID pattern for any "id"-suffixed param name (contracts/emit.mjs,
  // pre-existing, deliberately "a heuristic, not a guarantee") -- a plain numeric id (matching the
  // real fixture route's own :id([0-9]+) constraint) fails that guessed pattern. This is the exact
  // scenario that was structurally impossible before path-param names were extracted for this
  // provider at all -- proves the check is now genuinely wired, not just that a violation CAN be
  // produced some other way.
  {
    const before = receipts.length;
    const res = await fetch(\`\${base}/v1/users/42/bad-param\`);
    const body = await res.json();
    if (res.status !== 200 || body.name !== 'Bob') throw new Error(\`bad-param: client response was altered -- \${res.status} \${JSON.stringify(body)}\`);
    const receipt = await waitForReceipt(before);
    const hit = receipt.violations.find((v: any) => v.pointer === '/pathParams/id' && v.keyword === 'pattern');
    if (!hit) throw new Error(\`bad-param: expected a /pathParams/id pattern violation, got \${JSON.stringify(receipt.violations)}\`);
    if (JSON.stringify(receipt.violations).includes('42')) throw new Error(\`Decision A violation: the observed path-param value leaked into a violation message -- \${JSON.stringify(receipt.violations)}\`);
  }

  server.close();
  console.log('typescript-typecheck-smoke: real observeContract HTTP round trip PASSED (conformant / missing-field / bad-status / raw-string-uncaptured / bad-path-param)');
}

main().catch((err) => { console.error(err); process.exit(1); });
`;

const observeHttpDriverPath = path.join(backendDir, 'src', 'observe', 'http-test-driver.ts');
fs.writeFileSync(observeHttpDriverPath, OBSERVE_HTTP_DRIVER_SOURCE);
try {
	sh('npx', ['tsc', '--outDir', distDir, '--noEmit', 'false'], backendDir, { quiet: true });
} catch (err) {
	fail(`real tsc compile (for the observe HTTP round trip) failed:\n${err.stdout || err.stderr || err.message}`);
}
// Real bug found live, not assumed: tsc only compiles .ts files -- it never copies plain data
// files into --outDir, so observedSchema.ts's own runtime discovery (relative to its OWN compiled
// location, __dirname) finds nothing under dist/observe/schemas/ unless a build's own asset-copy
// step puts it there. Mirrors what a real target app's own build script would need to do --
// confirmed this is a genuine, not-tsc-specific-to-this-repo packaging step by reproducing the
// exact "no observed schema loaded" failure first, then fixing it, rather than assuming it away.
// observe.mjs's own postEmitNotes now name this explicitly for a real adopter.
fs.cpSync(path.join(backendDir, 'src', 'observe', 'schemas'), path.join(distDir, 'observe', 'schemas'), { recursive: true });
try {
	sh('node', [path.join(distDir, 'observe', 'http-test-driver.js')], backendDir, { quiet: true });
} catch (err) {
	fail(`real observeContract HTTP round trip failed:\n${err.stdout || err.stderr || err.message}`);
}

console.log('typescript-typecheck-smoke: PASS -- generated TypeScript type-checks cleanly against real TypeORM/Express types, the emitted handles router\'s GET pointer-walk works against a real HTTP round trip, and the emitted observeContract middleware correctly intercepts real traffic (conformant / missing-field / bad-status / raw-string-uncaptured / bad-path-param).');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
