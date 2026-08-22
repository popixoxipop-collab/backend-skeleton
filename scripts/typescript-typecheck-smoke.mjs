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

console.log('typescript-typecheck-smoke: PASS -- generated TypeScript type-checks cleanly against real TypeORM/Express types.');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
