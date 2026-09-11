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
  // D-typescript-express-registry-parity: featureUid/contractRef/dataSource are now real,
  // required fields on ResourceResolver -- this hand-built fake resolver (registered directly,
  // not through a real handles-emit resolver.ts) needs to satisfy the same interface a generated
  // one does. dataSource is never actually dereferenced here: this emit call doesn't pass
  // --enforce-registry on, so ENFORCE_REGISTRY renders false and requireRegisteredOrThrow() is
  // never called -- the cast below is a real, honest note that this driver doesn't exercise that
  // path (the enforcement-focused phase further down DOES provide a real DataSource).
  register({
    type: 'Thing',
    featureUid: '00000000-0000-0000-0000-000000000000',
    contractRef: 'fake-contract-ref-for-smoke-test',
    dataSource: null as any,
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
// The real, standards-compliant {id} path key -- contracts/openapi.mjs's canonicalRouteShape()
// now matches this against the scanned Express :id([0-9]+) route (D-openapi-reconciliation,
// closing D-runtime-conformance-receipts' own Finding 1). A real `responses.200` schema (not
// empty) is required to get a non-trivial `response`/`statuses` projection to actually exercise
// below -- an empty `responses: {}` (as used by the CLI test file, which only needs
// written-file-shape assertions) would make every response check vacuously pass.
const openApiPath = path.join(scratch, 'openapi.json');
fs.writeFileSync(openApiPath, JSON.stringify({
	openapi: '3.1.0',
	paths: {
		'/v1/users/{id}': {
			get: {
				operationId: 'users-show',
				responses: {
					200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
				},
				// D-business-rules (R9): a requestBody attached to this GET purely so the rules
				// phase below has real, contract-declared fields to author rules against -- not a
				// realistic REST shape, the same simplification java-compile-smoke.mjs's/python-
				// import-smoke.mjs's own business-rules phases already use.
				requestBody: {
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									capacity: { type: 'integer' },
									ownerName: { type: 'string' },
									status: { type: 'string', enum: ['draft', 'published', 'archived'] },
									startWindow: { type: 'string' },
									endWindow: { type: 'string' },
								},
							},
						},
					},
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

// D-openapi-path-params (A9, 59b3602) taught pathParamsSchema() to recognize Express's own :name
// syntax too, and D-openapi-reconciliation (this item) taught canonicalRouteShape() to match a
// real {id}-keyed OpenAPI document against a scanned :id([0-9]+) route -- together, path-param
// checking is now genuinely live for typescript-express, exercised by the "bad-param" scenario below.
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

// D-business-rules (R9): rules check -> rules emit --module users, against the requestBody
// attached to users-show above. Reuses the same scratch repo/node_modules (deliberate, same
// reasoning the observe phase's own comment gives -- proves rules coexists with handles/observe
// in one real repo).
console.log('typescript-typecheck-smoke: rules check -> rules emit --module users...');
fs.writeFileSync(path.join(scratch, 'specs', FEATURE_ID, 'rules.yaml'), `schema: sbf.feature-rules-source/1
rules:
  - id: capacity-cap
    kind: field
    operation: users-show
    pointer: /capacity
    assert: maximum
    value: 500
    reason: typescript-typecheck-smoke
  - id: owner-min
    kind: field
    operation: users-show
    pointer: /ownerName
    assert: minLength
    value: 3
    reason: typescript-typecheck-smoke
  - id: window-order
    kind: cross
    operation: users-show
    pointers: [/startWindow, /endWindow]
    assert: lt
    reason: typescript-typecheck-smoke
  - id: publish-flow
    kind: transition
    operation: users-show
    pointer: /status
    from: [draft]
    to: [published]
    reason: typescript-typecheck-smoke
`);
r = bskel(['rules', 'check', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`rules check: ${r.stderr || r.stdout}`);
r = bskel(['rules', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--json'], scratch);
if (r.code !== 0) fail(`rules emit: ${r.stderr || r.stdout}`);
let rulesEmitResult;
try {
	rulesEmitResult = JSON.parse(r.stdout);
} catch {
	fail(`rules emit produced no parseable JSON: ${r.stdout}`);
}
const expectedRulesFiles = ['backend/src/rules/ruleCheck.ts', 'backend/src/rules/ruleSet.ts', 'backend/src/rules/enforceRules.ts', 'backend/src/rules/rulesSchemas/001-user-management.rules.json'];
for (const f of expectedRulesFiles) {
	if (!rulesEmitResult.written.includes(f)) fail(`rules emit: expected ${f} in written, got ${JSON.stringify(rulesEmitResult.written)}`);
}

// The real toolchain proof: a real tsc compile, then a real Express app using the REAL generated
// enforceRules('users-show') middleware, driven over a real HTTP round trip -- proving both the
// pure executor (ruleCheck/ruleSet) AND the observe/enforce mode branching, mirroring
// java-compile-smoke.mjs's RuleExecSmokeTest + RuleEnforcementAspectSmokeTest combined into one
// driver (TS has no JVM-style mocking ceremony needed -- a real Express app IS the cheapest way
// to drive middleware here, the same call the observe HTTP driver above already made).
const RULES_DRIVER_SOURCE = `
import express from 'express';
import http from 'node:http';
import * as ruleCheck from './ruleCheck';
import * as ruleSet from './ruleSet';
import { enforceRules } from './enforceRules';

async function main() {
  // ---- pure executor proof ----
  const rules = ruleSet.forOperation('users-show');
  if (rules.field.length === 0 || rules.cross.length === 0 || rules.transition.length === 0) {
    throw new Error(\`expected all three predicate kinds compiled, got \${JSON.stringify(rules)}\`);
  }
  const violatingBody = { capacity: 999, ownerName: 'x', startWindow: '2026-01-02', endWindow: '2026-01-01' };
  const violating = [
    ...ruleCheck.check(rules, violatingBody),
    ...ruleCheck.checkTransitions(rules, { status: 'published' }, { '/status': 'archived' }),
  ];
  if (violating.length !== 4) throw new Error(\`expected 4 violations (capacity-cap, owner-min, window-order, publish-flow), got \${violating.length}: \${JSON.stringify(violating.map((v) => v.ruleId))}\`);
  const gotIds = violating.map((v) => v.ruleId).sort();
  const wantIds = ['capacity-cap', 'owner-min', 'window-order', 'publish-flow'].sort();
  if (JSON.stringify(gotIds) !== JSON.stringify(wantIds)) throw new Error(\`got \${JSON.stringify(gotIds)}\`);

  const validBody = { capacity: 100, ownerName: 'widget-owner', startWindow: '2026-01-01', endWindow: '2026-01-02' };
  const valid = [
    ...ruleCheck.check(rules, validBody),
    ...ruleCheck.checkTransitions(rules, { status: 'published' }, { '/status': 'draft' }),
  ];
  if (valid.length !== 0) throw new Error(\`expected 0 violations against a payload deliberately constructed to satisfy every rule, got \${valid.length}: \${JSON.stringify(valid.map((v) => v.ruleId))}\`);

  // ---- enforceRules() middleware proof, real HTTP round trip ----
  const app = express();
  app.use(express.json());
  app.patch('/v1/users/:id/observe', enforceRules('users-show'), (req, res) => { res.json({ ran: 'REAL_HANDLER' }); });
  app.patch('/v1/users/:id/enforce', enforceRules('users-show'), (req, res) => { res.json({ ran: 'REAL_HANDLER' }); });
  app.patch('/v1/users/:id/no-rules', enforceRules('no-such-operation-for-smoke-test'), (req, res) => { res.json({ ran: 'REAL_HANDLER' }); });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = \`http://127.0.0.1:\${port}\`;

  // (1) observe mode (default): always proceeds, even with real violations
  {
    const res = await fetch(\`\${base}/v1/users/1/observe\`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(violatingBody) });
    const body = await res.json();
    if (res.status !== 200 || body.ran !== 'REAL_HANDLER') throw new Error(\`observe mode: expected the real handler to run, got \${res.status} \${JSON.stringify(body)}\`);
  }

  // (2) enforce mode: a real violation rejects with 400, the real handler never runs, and the
  // response never leaks the observed value
  {
    process.env.BSKEL_RULES_MODE = 'enforce';
    const secretMarker = 'SECRET_MARKER_VALUE_12345';
    const res = await fetch(\`\${base}/v1/users/1/enforce\`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity: 999, ownerName: secretMarker }) });
    const body = await res.json();
    if (res.status !== 400) throw new Error(\`enforce mode: expected 400, got \${res.status} \${JSON.stringify(body)}\`);
    if (body.ran === 'REAL_HANDLER') throw new Error('enforce mode: the real handler must never run when a real violation is rejected');
    const detail = JSON.stringify(body);
    if (!detail.includes('capacity-cap')) throw new Error(\`enforce mode: message should name the real rule id: \${detail}\`);
    if (detail.includes(secretMarker)) throw new Error(\`Decision A violation: an enforce-mode rejection leaked an observed payload value: \${detail}\`);
    if (detail.includes('999')) throw new Error(\`Decision A violation: an enforce-mode rejection leaked an observed numeric value: \${detail}\`);
  }

  // (3) enforce mode, valid payload: always proceeds
  {
    const res = await fetch(\`\${base}/v1/users/1/enforce\`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validBody) });
    const body = await res.json();
    if (res.status !== 200 || body.ran !== 'REAL_HANDLER') throw new Error(\`enforce mode, valid payload: expected the real handler to run, got \${res.status} \${JSON.stringify(body)}\`);
  }

  // (4) an operation with no compiled rules is a silent no-op, even in enforce mode
  {
    const res = await fetch(\`\${base}/v1/users/1/no-rules\`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    if (res.status !== 200 || body.ran !== 'REAL_HANDLER') throw new Error(\`no-rules: expected the real handler to run, got \${res.status} \${JSON.stringify(body)}\`);
  }

  delete process.env.BSKEL_RULES_MODE;
  server.close();
  console.log('typescript-typecheck-smoke: real enforceRules HTTP round trip PASSED (observe always proceeds / enforce rejects real violations without leaking values / valid payload proceeds / rule-less operation is a no-op)');
}

main().catch((err) => { console.error(err); process.exit(1); });
`;
const rulesDriverPath = path.join(backendDir, 'src', 'rules', 'http-test-driver.ts');
fs.writeFileSync(rulesDriverPath, RULES_DRIVER_SOURCE);
try {
	sh('npx', ['tsc', '--outDir', distDir, '--noEmit', 'false'], backendDir, { quiet: true });
} catch (err) {
	fail(`real tsc compile (for the rules HTTP round trip) failed:\n${err.stdout || err.stderr || err.message}`);
}
// Same real packaging gap observe's own driver already found and worked around: tsc never copies
// plain data files into --outDir, so ruleSet.ts's own runtime discovery (relative to its OWN
// compiled location, __dirname) finds nothing under dist/rules/rulesSchemas/ unless copied.
fs.cpSync(path.join(backendDir, 'src', 'rules', 'rulesSchemas'), path.join(distDir, 'rules', 'rulesSchemas'), { recursive: true });
try {
	sh('node', [path.join(distDir, 'rules', 'http-test-driver.js')], backendDir, { quiet: true });
} catch (err) {
	fail(`real rules HTTP round trip failed:\n${err.stdout || err.stderr || err.message}`);
}
console.log('typescript-typecheck-smoke: PASS -- real generated ruleCheck/ruleSet correctly detected all 4 real violations, and correctly passed a valid payload; real enforceRules HTTP round trip passed.');

// D-typescript-express-registry-parity: proves the new registry stack (handleEntities.ts/
// handleService.ts/recordSnapshotWrapper.ts/<Type>Policy.ts/router.ts's recover()+enforcement
// logic) actually compiles against real TypeORM types, not just that it renders as syntactically
// plausible strings -- the whole point of this script existing at all (see its own header). Run
// LAST, deliberately: this re-emit bakes ENFORCE_REGISTRY=true into the shared scratch repo's own
// router.ts, which would make the EARLIER HTTP-round-trip driver's hand-registered fake resolver
// (dataSource: null) crash for real inside requireRegisteredOrThrow() -- found live, not assumed,
// by originally placing this phase before the HTTP round trip and watching it crash exactly that
// way. Ordering this phase last means every earlier phase's own assumption (enforcement off)
// stays true for its own run, and nothing after this phase depends on enforcement being off again.
console.log('typescript-typecheck-smoke: re-emitting with --enforce-registry on --force --reason, re-typechecking...');
r = bskel(['handles', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--enforce-registry', 'on', '--force', '--reason', 'typescript-typecheck-smoke: verifying the registry stack compiles for real', '--json'], scratch);
if (r.code !== 0) fail(`handles emit --enforce-registry on --force: ${r.stderr || r.stdout}`);
let enforceEmitResult;
try {
	enforceEmitResult = JSON.parse(r.stdout);
} catch {
	fail(`handles emit --enforce-registry on produced no parseable JSON: ${r.stdout}`);
}
const expectedRegistryFiles = ['backend/src/handles/handleEntities.ts', 'backend/src/handles/handleService.ts', 'backend/src/handles/recordSnapshotWrapper.ts', 'backend/src/handles/resolvers/userPolicy.ts', 'specs/001-user-management/handles/migration.sql'];
for (const f of expectedRegistryFiles) {
	if (!emitResult.written.includes(f) && !enforceEmitResult.written.includes(f)) fail(`expected ${f} to have been written by one of the two handles emit calls -- got ${JSON.stringify(emitResult.written)} then ${JSON.stringify(enforceEmitResult.written)}`);
}
try {
	sh('npx', ['tsc', '--noEmit'], backendDir, { quiet: true });
} catch (err) {
	fail(`tsc --noEmit found real type errors in generated code AFTER --enforce-registry on:\n${err.stdout || err.stderr || err.message}`);
}
console.log('typescript-typecheck-smoke: registry-parity phase PASSED (real tsc --noEmit, twice, against the full registry stack).');

fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
