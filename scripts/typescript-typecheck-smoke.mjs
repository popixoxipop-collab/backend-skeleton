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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'typescript-express');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const FEATURE_ID = '001-user-management';

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function fail(message) {
	console.error(`typescript-typecheck-smoke: FAIL -- ${message}`);
	process.exit(1);
}

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

console.log('typescript-typecheck-smoke: preflight -> feature init -> scan -> disposition -> handles emit...');
let r = bskel(['preflight'], scratch);
if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);

r = bskel(['feature', 'init', '--slug', 'user-management'], scratch);
if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

r = bskel(['scan', '--feature', FEATURE_ID, '--terms', 'user'], scratch);
if (![0, 3].includes(r.code)) fail(`scan: exit ${r.code}: ${r.stderr || r.stdout}`);

r = bskel(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'extend', '--note', 'typescript-typecheck-smoke'], scratch);
if (r.code !== 0) fail(`scan disposition: ${r.stderr || r.stdout}`);

// No OpenAPI oracle exists for plain Express (D-typescript-express-provider) -- contract emit is
// out of scope for this smoke script, same as test/typescript-express-handles.test.mjs's own e2e
// fixture forces past it. This script's only concern is real type-checking of generated codegen.
r = bskel(['gate', 'force', 'contract', '--feature', FEATURE_ID, '--reason', 'handles-only smoke test, no OpenAPI oracle for this ecosystem'], scratch);
if (r.code !== 0) fail(`gate force contract: ${r.stderr || r.stdout}`);

// D-cross-feature-collision: see java-compile-smoke.mjs's own identical note -- `handles emit`
// hard-requires this gate; missed here because this script isn't part of `npm test`'s glob.
r = bskel(['scan', 'cross-feature-check', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`scan cross-feature-check: ${r.stderr || r.stdout}`);

r = bskel(['handles', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--json'], scratch);
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

console.log('typescript-typecheck-smoke: PASS -- generated TypeScript type-checks cleanly against real TypeORM/Express types, and the emitted router\'s GET pointer-walk works against a real HTTP round trip.');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
