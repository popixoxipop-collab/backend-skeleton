// G6 (D-javascript-express-adapter): unit tests for scanners/adapters/_express-shared.mjs's
// comment masker, plus the phantom-route regression it fixes in BOTH Express adapters.
//
// `maskJsComments()` was added because an unmasked regex genuinely cannot tell code from prose
// about code -- the same defect A2 Phase 1's `maskNonCode()` fixed for Java (D-java-analyzer). It
// is exercised here directly, not only through a scan, because the two properties that matter
// (offsets never shift, string literals survive intact) are invisible in an end-to-end assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskJsComments } from '../scanners/adapters/_express-shared.mjs';
import { scanTypeScriptExpress, detectTypeScriptExpressRoot } from '../scanners/adapters/typescript-express.mjs';
import { scanJavaScriptExpress, detectJavaScriptExpressRoot } from '../scanners/adapters/javascript-express.mjs';

test('maskJsComments blanks line and block comments entirely, markers included', () => {
	const src = 'const a = 1; // router.get("/x", h)\n/* router.post("/y", h) */\nconst b = 2;';
	const masked = maskJsComments(src);
	assert.ok(!masked.includes('router.get'), 'a line comment must not survive masking');
	assert.ok(!masked.includes('router.post'), 'a block comment must not survive masking');
	assert.ok(masked.includes('const a = 1;'));
	assert.ok(masked.includes('const b = 2;'));
});

// The property every offset-based consumer depends on: masking blanks characters in place, it
// never deletes them. matchBalancedParens()/lineNumberAt() results computed against masked text
// must still index correctly into the original.
test('maskJsComments preserves length, newline positions, and every non-comment character index', () => {
	const src = 'a();\n// gone\nb(\n  /* also\n gone */ 1);\n';
	const masked = maskJsComments(src);
	assert.equal(masked.length, src.length, 'masking must not change length');
	assert.equal(masked.split('\n').length, src.split('\n').length, 'masking must not change line count');
	for (let i = 0; i < src.length; i++) {
		if (masked[i] !== ' ') assert.equal(masked[i], src[i], `index ${i} must be unchanged when not blanked`);
	}
});

// The single most likely way a naive masker breaks real code: `//` inside a URL string.
test('maskJsComments never starts a comment inside a string, template, or after an escaped quote', () => {
	const src = [
		"const url = 'https://example.com/a';",
		'const t = `https://example.com/b /* not a comment */`;',
		"const q = 'it\\'s // not a comment';",
		'const d = "a /* b */ c";',
	].join('\n');
	const masked = maskJsComments(src);
	assert.equal(masked, src, 'no character inside a string or template literal may be blanked');
});

// A regex literal containing an odd number of quote characters used to put the scanner into a
// phantom string that ran to the next quote ANYWHERE later in the file, leaving every comment in
// between unmasked -- reintroducing exactly the phantom-route bug this function exists to prevent.
// Confirmed live before regex tracking was added.
test('maskJsComments tracks regex literals, so a regex containing a quote does not swallow the rest of the file', () => {
	const src = ["const re = /'/g;", "// router.get('/phantom', h)", "router.get('/real', h);"].join('\n');
	const masked = maskJsComments(src);
	assert.ok(!masked.includes('phantom'), 'the comment after a quote-containing regex must still be masked');
	assert.ok(masked.includes("'/real'"), 'real code after it must survive');
	assert.equal(masked.length, src.length);
});

// The other half of regex tracking: `/` is far more often division, and misreading it as a regex
// start would skip real code. Decided from the previous significant character.
test('maskJsComments does not mistake division for a regex literal', () => {
	const src = ['const half = total / 2;', "// router.get('/phantom', h)", 'const rest = total % 2;'].join('\n');
	const masked = maskJsComments(src);
	assert.ok(!masked.includes('phantom'), 'the following comment must still be masked');
	assert.ok(masked.includes('const half = total / 2;'), 'the division expression must survive untouched');
	assert.ok(masked.includes('const rest = total % 2;'));
});

test('maskJsComments handles a `/` inside a regex character class without ending the literal early', () => {
	const src = ['const sep = /[/]/;', "// router.get('/phantom', h)", 'const done = true;'].join('\n');
	const masked = maskJsComments(src);
	assert.ok(!masked.includes('phantom'));
	assert.ok(masked.includes('const done = true;'));
});

// String literals must survive INTACT (unlike the Java masker, which blanks string interiors):
// every path these adapters report is read straight out of a string literal.
test('maskJsComments leaves route path literals readable after masking', () => {
	const src = "// router.get('/phantom', h)\nrouter.get('/real/:id', handler);";
	const masked = maskJsComments(src);
	assert.ok(masked.includes("'/real/:id'"), 'a real path literal must still be readable');
	assert.ok(!masked.includes('/phantom'), 'a commented-out path literal must not be');
});

function writeTree(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-express-shared-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return root;
}

// Regression for the phantom-route bug in the G5 adapter, fixed by G6. Before masking, a
// commented-out registration was extracted and reported as a live endpoint.
test('typescript-express: a commented-out router.get is NOT reported as a live endpoint', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/things.ts': [
			"import { Router } from 'express';",
			'const router = Router();',
			"router.get('/:id', show);",
			"// router.get('/retired', retiredHandler);",
			"/* router.post('/bulk', bulkHandler); */",
			'export default router;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot, 'fixture must be detected by typescript-express');
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /:id']);
});

// D-typescript-express-inline-handlers: real shape found live dogfooding
// gothinkster/node-express-realworld-example-app (3,796 real GitHub stars) -- ALL 19 of its real
// route registrations use an inline handler, not a named reference; before this fix, this exact
// idiom found ZERO endpoints anywhere in that whole repo (verdict: greenfield on a repo with a
// real, complete REST API).
test('typescript-express: an inline async arrow-function handler (not a named reference) is now found -- method is null, not guessed', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/articles.ts': `import { Router, Request, Response, NextFunction } from 'express';
const router = Router();
router.get('/articles', async (req: Request, res: Response, next: NextFunction) => {
  res.json({ articles: [] });
});
export default router;
`,
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot, 'fixture must be detected by typescript-express');
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /articles']);
	assert.equal(endpoints[0].method, null, 'an inline handler has no name to correlate to a defining file');
});

test('typescript-express: a plain (non-async) inline arrow-function handler, a single unparenthesized param, and a traditional function() handler are all recognized', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/things.ts': [
			"import { Router } from 'express';",
			'const router = Router();',
			"router.get('/a', (req, res) => { res.json({}); });",
			"router.get('/b', req => { req.res.json({}); });",
			"router.get('/c', async function (req, res) { res.json({}); });",
			'export default router;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), ['GET /a', 'GET /b', 'GET /c']);
	assert.ok(endpoints.every((e) => e.method === null));
});

test('typescript-express: a handler that is neither a bare identifier nor a recognizable inline function (a member expression) is still skipped, not guessed at', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/things.ts': [
			"import { Router } from 'express';",
			"import controller from '../controller';",
			'const router = Router();',
			"router.get('/x', controller.show);",
			'export default router;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('javascript-express: a commented-out router.get is NOT reported as a live endpoint', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'src/routes/things.route.js': [
			"import express from 'express';",
			'const router = express.Router();',
			"router.get('/:id', show);",
			"// router.get('/retired', retiredHandler);",
			"/* router.post('/bulk', bulkHandler); */",
			'export default router;',
		].join('\n'),
	});
	const detection = detectJavaScriptExpressRoot(root);
	assert.ok(detection, 'fixture must be detected by javascript-express');
	const result = scanJavaScriptExpress(root, detection);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /:id']);
});

// `Router({ mergeParams: true })` is ordinary Express. Both adapters previously required LITERALLY
// empty parens (`/\bRouter\s*\(\s*\)/`) in their detect signal, and typescript-express in its
// per-file gate as well -- so a repo whose routers all pass options was skipped entirely. Found by
// probing the regex directly against real Express idioms, not by an end-to-end failure.
test('typescript-express: a router declared as Router({ mergeParams: true }) is still detected and scanned', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/things.ts': [
			"import { Router } from 'express';",
			'const router = Router({ mergeParams: true });',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot, 'a Router({...}) declaration must still satisfy detect()');
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /:id']);
});

test('typescript-express: `default as` named specifier still authorizes the Express application factory', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import { default as express, Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			"app.get('/health', healthHandler);",
			"app.use('/api', router);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /health',
	]);
});
test('typescript-express: combined default+named import and typed arbitrary Router variables preserve mount prefixes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/index.ts': [
			"import express, { Router } from 'express';",
			"import userRouter from './users';",
			'const apiRouter: Router = express.Router();',
			"apiRouter.use('/users', userRouter);",
			'export default apiRouter;',
		].join('\n'),
		'src/routes/users.ts': [
			"import express, { Router } from 'express';",
			'const userRouter: Router = express.Router();',
			"userRouter.get('/:id', authentication, getUserById);",
			'export default userRouter;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot, 'default+named Express import with typed Router variable must detect');
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => e.verb + ' ' + e.path), ['GET /users/:id']);
	assert.equal(endpoints[0].method, 'getUserById');
});

test('typescript-express: an express() application receiver contributes its own route and absolute prefixes for imported routers', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express from 'express';",
			"import userRouter from './routes/user.routes';",
			"import authRouter from './routes/auth.routes';",
			'export const application = express();',
			'const authenticate = (req, res, next) => next();',
			'export const Main = async () => {',
			"  application.get('/main/healthcheck', (req, res, next) => res.status(200).json({ ok: true }));",
			"  application.use('/api/users', authenticate, userRouter);",
			"  application.use('/api/auth', authenticate, authRouter);",
			'};',
		].join('\n'),
		'src/routes/auth.routes.ts': [
			"import express, { Router } from 'express';",
			'const authRouter: Router = express.Router();',
			"authRouter.post('/register', registerUser);",
			"authRouter.post('/login', loginUser);",
			'export default authRouter;',
		].join('\n'),
		'src/routes/user.routes.ts': [
			"import express, { Router } from 'express';",
			'const userRouter: Router = express.Router();',
			"const authentication = (req, res, next) => next();",
			"const authorizeRoles = () => (req, res, next) => next();",
			"const protectedRoute = (req, res) => res.sendStatus(200);",
			"const getUserById = (req, res) => res.sendStatus(200);",
			"const deleteUser = (req, res) => res.sendStatus(204);",
			"const updateUser = (req, res) => res.sendStatus(200);",
			"userRouter.get('/protected', authentication, protectedRoute);",
			"userRouter.get('/:id', authentication, getUserById);",
			"userRouter.delete('/:id', authentication, authorizeRoles('admin'), deleteUser);",
			"userRouter.put('/:id', authentication, updateUser);",
			'export default userRouter;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot, 'the Router-bearing child modules must detect the TypeScript Express project');
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'DELETE /api/users/:id',
		'GET /api/users/:id',
		'GET /api/users/protected',
		'GET /main/healthcheck',
		'POST /api/auth/login',
		'POST /api/auth/register',
		'PUT /api/users/:id',
	].sort());
});

test('typescript-express: application calls before the express() factory declaration are rejected', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			"app.get('/phantom-before', phantomHandler);",
			'const app = express();',
			"app.get('/real', realHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});
test('typescript-express: same-file app -> router mounts keep receiver-specific prefixes and reject dynamic paths', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"const suffix = '/v1';",
			"app.get('/health', rootHealth);",
			"app.get('/computed' + suffix, computedHealth);",
			"router.get('/users', listUsers);",
			"app.use('/wrong' + suffix, router);",
			"app.use('/api', router);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/users',
		'GET /health',
	]);
});

test('typescript-express: a shadowed default-import name inside a nested scope cannot authorize a phantom application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			"router.get('/real', realHandler);",
			'function build(express: () => unknown) {',
			'  const app = express();',
			"  app.get('/phantom', phantomHandler);",
			'  return app;',
			'}',
			'export default router;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: a nested parameter shadowing an authorized app name cannot contribute routes or mounts', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			"app.get('/real', realHandler);",
			"app.use('/api', router);",
			'function configure(app: { get: Function; use: Function }) {',
			"  app.get('/phantom', phantomHandler);",
			"  app.use('/wrong', router);",
			'}',
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /real',
	]);
});

test('typescript-express: destructuring cannot shadow an authorized app receiver into phantom routes or mounts', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			"app.get('/real', realHandler);",
			"app.use('/api', router);",
			'function localShadow(source: { app: { get: Function; use: Function } }) {',
			'  const { app } = source;',
			"  app.get('/phantom-local', phantomHandler);",
			"  app.use('/wrong-local', router);",
			'}',
			'function parameterShadow({ app }: { app: { get: Function; use: Function } }) {',
			"  app.get('/phantom-param', phantomHandler);",
			"  app.use('/wrong-param', router);",
			'}',
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /real',
	]);
});

test('typescript-express: lexical scope resolution rejects shadowed mount targets and ignores exited child bindings', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			"app.use('/api', router);",
			'function configure(router: { get: Function }) {',
			"  app.use('/wrong', router);",
			'}',
			'function configureDefault({ app } = makeSource()) {',
			"  app.get('/phantom-default', phantomHandler);",
			'}',
			'function afterClosedBlock() {',
			'  { const app = fakeApp; app.get(\'/phantom-inner\', phantomHandler); }',
			"  app.get('/after-block', realHandler);",
			'}',
			'fakeApps.forEach(app => app.get(\'/phantom-arrow\', phantomHandler));',
			"fakeApps.map(app => /x,/.test(value) && app.get('/phantom-arrow-regex-comma', phantomHandler));",
			'function forHeaderShadow() {',
			"  for (const app of fakeApps) { app.get('/phantom-for-loop', phantomHandler); }",
			"  app.get('/after-for-loop', afterForHandler);",
			'}',
			'function unbracedForHeaderShadow() {',
			"  for (const app of fakeApps) app.get('/phantom-unbraced-for', phantomHandler);",
			"  app.get('/after-unbraced-for', afterUnbracedForHandler);",
			'}',
			'function unbracedForElseShadow() {',
			"  for (const app of fakeApps) if (ok) app.get('/phantom-unbraced-if', phantomHandler); else app.get('/phantom-unbraced-else', phantomHandler);",
			"  app.get('/after-unbraced-else', afterUnbracedElseHandler);",
			'}',
			'async function forAwaitShadow() {',
			"  for await (const app of items) app.get('/phantom-for-await', phantomHandler);",
			"  app.get('/after-for-await', afterForAwaitHandler);",
			'}',
			'function varShadow() {',
			'  { var app = fakeApp; }',
			"  app.get('/phantom-var', phantomHandler);",
			'}',
			'function multilineShadow(source: { app: { get: Function } }) {',
			'  const {',
			'    app,',
			'  } = source;',
			"  app.get('/phantom-multiline', phantomHandler);",
			'}',
			'const inspect = app => app.name',
			"app.get('/after-asi', asiHandler)",
			'function objectReturnType(): { ok: boolean } {',
			'  { var app = fakeApp; }',
			"  app.get('/phantom-object-return', phantomHandler);",
			'  return { ok: true };',
			'}',
			'class Holder {',
			'  constructor(private readonly app: { get: Function }) {',
			"    app.get('/phantom-parameter-property', phantomHandler);",
			'  }',
			'}',
			'function stringNoise() {',
			"  const source = 'const app = fake;';",
			"  app.get('/after-string', stringHandler);",
			'}',
			'function continuedDeclaration() {',
			'  const other = fake,',
			'    app = fakeApp;',
			"  app.get('/phantom-continued', phantomHandler);",
			'}',
			'function regexBraceShadow() {',
			'  /[}]/;',
			'  const app = fakeApp;',
			"  app.get('/phantom-regex-brace', phantomHandler);",
			'}',
			'function regexInitializerNoise() {',
			'  const pattern = /x, app/;',
			"  app.get('/after-regex-initializer', regexHandler);",
			'}',
			'function arrowRegexThenShadow() {',
			'  const pattern = () => /[}]/;',
			'  const app = fakeApp;',
			"  app.get('/phantom-arrow-regex', phantomHandler);",
			'}',
			'function throwRegexThenShadow() {',
			'  throw /[}]/;',
			'  const app = fakeApp;',
			"  app.get('/phantom-throw-regex', phantomHandler);",
			'}',
			'const namedFunction = function app() {',
			"  app.get('/phantom-named-function', phantomHandler);",
			'};',
			"const HeritageHolder = class app extends app.get('/phantom-class-heritage', phantomHandler) {};",
			'const namedGenericFunction = function app<T>() {',
			"  app.get('/phantom-generic-named-function', phantomHandler);",
			'};',
			"const namedFunctionDefault = function app(x = app.get('/phantom-named-function-default', phantomHandler)) {};",
			'const namedGenerator = function* app() {',
			"  app.get('/phantom-generator-name', phantomHandler);",
			'};',
			'const namedAsyncGenerator = async function* app() {',
			"  app.get('/phantom-async-generator-name', phantomHandler);",
			'};',
			'const namedClass = class app {',
			"  method() { app.get('/phantom-class-name', phantomHandler); }",
			'};',
			'function staleControlHeaderDivision() {',
			'  if (enabled) run();',
			'  const n = value() / 2; const app = fakeApp;',
			"  app.get('/phantom-stale-control-division', phantomHandler);",
			'}',
			'function divisionAfterObjectLiteral() {',
			'  const n = <any>{} / 2; const app = fakeApp;',
			"  app.get('/phantom-object-division', phantomHandler);",
			'}',
			'function sameLineBlockRegex() {',
			'  const blockRouter: Router = Router();',
			'  if (enabled) {} /[}]/.test(value);',
			"  blockRouter.get('/child', blockHandler);",
			"  app.use('/block-regex', blockRouter);",
			'}',
			'function controlHeaderRegexThenShadow() {',
			'  if (enabled) /[}]/.test(value);',
			'  const app = fakeApp;',
			"  app.get('/phantom-control-regex', phantomHandler);",
			'}',
			"function parameterDefault(app = fakeApp, x = app.get('/phantom-param-default', phantomHandler)) {}",
			"function regexParameter(app = fakeApp, pattern = /[)]/) { app.get('/phantom-regex-parameter', phantomHandler); }",
			'class MethodHolder {',
			"  configure(app = fakeApp, x = app.get('/phantom-method-default', phantomHandler)) {}",
			"  generic<T>(app = fakeApp, x = app.get('/phantom-generic-method-default', phantomHandler)) {}",
			"  ['computed'](app = fakeApp, x = app.get('/phantom-computed-method-default', phantomHandler)) {}",
			'}',
			'const objectHolder = {',
			"  configure(app = fakeApp, x = app.get('/phantom-object-method-default', phantomHandler)) {},",
			"  generic<T>(app = fakeApp, x = app.get('/phantom-generic-object-method-default', phantomHandler)) {},",
			"  ['computed'](app = fakeApp, x = app.get('/phantom-computed-object-method-default', phantomHandler)) {},",
			"  'configure'(app = fakeApp, x = app.get('/phantom-literal-method-default', phantomHandler)) {},",
			"  123(app = fakeApp, x = app.get('/phantom-numeric-method-default', phantomHandler)) {},",
			"  0x1(app = fakeApp, x = app.get('/phantom-hex-method-default', phantomHandler)) {},",
			"  1e3(app = fakeApp, x = app.get('/phantom-exponent-method-default', phantomHandler)) {},",
			"  2n(app = fakeApp, x = app.get('/phantom-bigint-method-default', phantomHandler)) {},",
			'};',
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /after-asi',
		'GET /after-block',
		'GET /after-for-await',
		'GET /after-for-loop',
		'GET /after-regex-initializer',
		'GET /after-string',
		'GET /after-unbraced-else',
		'GET /after-unbraced-for',
		'GET /api/child',
		'GET /block-regex/child',
	]);
});
test('typescript-express: source-like route and mount calls inside strings are ignored', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			"const fakeImport = \"import factory from 'express'\";",
			'const unrelated = factory();',
			"unrelated.get('/phantom-fake-import', phantomHandler);",
			'const app = express();',
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			'const example = "app.get(\'/phantom\', phantomHandler)";',
			'const mountExample = "app.use(\'/wrong\', router)";',
			"app.get('/real', realHandler);",
			"app.use('/api', router);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /real',
	]);
});
test('typescript-express: a reused Router mounted under multiple prefixes exposes every absolute route', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			"app.use('/v1', router);",
			"app.use('/v2', router);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /v1/child',
		'GET /v2/child',
	]);
});
test('typescript-express: same-named Router bindings in separate scopes keep distinct mount prefixes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'function one() {',
			'  const router: Router = Router();',
			"  router.get('/one', oneHandler);",
			"  app.use('/a', router);",
			'}',
			'function two() {',
			'  const router: Router = Router();',
			"  router.get('/two', twoHandler);",
			"  app.use('/b', router);",
			'}',
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /a/one',
		'GET /b/two',
	]);
});
test('typescript-express: default export specifier aliases preserve imported router mount prefixes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			"import child from './child';",
			'const app = express();',
			"app.use('/api', child);",
			'export default app;',
		].join('\n'),
		'src/child.ts': [
			"import { Router } from 'express';",
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			'export { router as default };',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/child']);
});
test('typescript-express: an out-of-scope same-named local Router does not suppress the active imported mount target', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			"const importExample = \"import router from './wrong'\";",
			"import router from './child';",
			'const app = express();',
			"app.use('/api', router);",
			'function unrelated() {',
			'  const router: Router = Router();',
			"  router.get('/local-only', localHandler);",
			'}',
			'export default app;',
		].join('\n'),
		'src/child.ts': [
			"import { Router } from 'express';",
			'const child: Router = Router();',
			"child.get('/child', childHandler);",
			"const exportExample = 'export default fake;';",
			'export default child;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /local-only',
	]);
});
test('typescript-express: express() in a later variable declarator keeps direct routes and mount prefixes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const unused = 1, app = express();',
			'const router: Router = Router();',
			"app.get('/health', healthHandler);",
			"router.get('/child', childHandler);",
			"app.use('/api', router);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /health',
	]);
});
test('typescript-express: Router() in a later variable declarator is detected and mounted', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const unused = 1, router: Router = Router();',
			"router.get('/child', childHandler);",
			"app.use('/api', router);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/child']);
});
test('typescript-express: for-header shadow ends after an unbraced braced statement body', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			'for (const app of fakeApps) switch (mode) {',
			"  case 1: app.get('/phantom-loop', phantomHandler); break;",
			'}',
			"app.get('/real', realHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});
test('typescript-express: for-header shadow ends after an unbraced try/finally body', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			'for (const app of fakeApps) try {',
			"  app.get('/phantom-loop', phantomHandler);",
			'} finally {',
			'  cleanup();',
			'}',
			"app.get('/real', realHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});
test('typescript-express: for-header shadow includes a complete unbraced do/while body', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"for (const app of fakeApps) do work(); while (app.get('/phantom-loop', phantomHandler));",
			"app.get('/real', realHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});
test('typescript-express: Router() declared in a for header is the active receiver inside that loop body', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'function install() {',
			'  for (const router: Router = Router(); cond; step()) {',
			"    router.get('/child', childHandler);",
			"    app.use('/for-api', router);",
			'  }',
			'}',
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /for-api/child']);
});
test('typescript-express: var Router() declared in a child block remains visible in its containing function', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'function install() {',
			'  { var router: Router = Router(); }',
			"  router.get('/child', childHandler);",
			"  app.use('/api', router);",
			'}',
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/child']);
});
test('typescript-express: a Router() declared and mounted inside a function keeps its local mount prefix', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'function install() {',
			'  const localRouter: Router = Router();',
			"  localRouter.get('/child', childHandler);",
			"  app.use('/local-api', localRouter);",
			'}',
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /local-api/child']);
});
test('typescript-express: empty express() factories remain trusted through bounded as/satisfies type assertions', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			'const app = express() as Application;',
			'const secondary = express() satisfies Application;',
			'const parenthesized = (express() as Application);',
			'const prefixed = <express.Application>express();',
			'const parenthesizedPrefixed = (<express.Application>express());',
			'const outerAsserted = (express()) as Application;',
			'const augmented = express() as express.Express & { feature: string };',
			'const unioned = express() as express.Express | { feature: string };',
			'const tupled = express() as unknown as [express.Express, express.Express];',
			'const objectTyped = express() as unknown as { feature: string; enabled: boolean };',
			"app.get('/health', healthHandler);",
			"secondary.get('/secondary', secondaryHandler);",
			"parenthesized.get('/parenthesized', parenthesizedHandler);",
			"prefixed.get('/prefixed', prefixedHandler);",
			"parenthesizedPrefixed.get('/parenthesized-prefixed', parenthesizedPrefixedHandler);",
			"outerAsserted.get('/outer-asserted', outerAssertedHandler);",
			"augmented.get('/augmented', augmentedHandler);",
			"unioned.get('/unioned', unionedHandler);",
			"tupled.get('/tupled', tupledHandler);",
			"objectTyped.get('/object-typed', objectTypedHandler);",
			"app.use('/api', router);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /augmented',
		'GET /health',
		'GET /object-typed',
		'GET /outer-asserted',
		'GET /parenthesized',
		'GET /parenthesized-prefixed',
		'GET /prefixed',
		'GET /secondary',
		'GET /tupled',
		'GET /unioned',
	]);
});

test('typescript-express: mutable application bindings stop authorizing routes after top-level reassignment', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			'let app = express();',
			"app.get('/before', beforeHandler);",
			"app.use('/api', router);",
			'app = fakeApp;',
			"app.get('/phantom', phantomHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /before',
	]);
});

test('typescript-express: a definite app write in a top-level sequence invalidates the mutable binding', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app = express();',
			"app.get('/before', beforeHandler);",
			'cleanup(), app = fakeApp;',
			"app.get('/phantom-after-sequence', phantomHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /before']);
});
test('typescript-express: a parenthesized top-level sequence write invalidates the mutable app binding', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app = express();',
			"app.get('/before', beforeHandler);",
			'(cleanup(), app = fakeApp);',
			"app.get('/phantom-after-parenthesized-sequence', phantomHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /before']);
});
test('typescript-express: grouping around the final sequence assignment target still invalidates the mutable app', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app = express();',
			"app.get('/before', beforeHandler);",
			'cleanup(), (app = fakeApp);',
			"app.get('/phantom-after-grouped-target', phantomHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /before']);
});
test('typescript-express: ||= and ??= preserve an already trusted express() application binding', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app = express();',
			'app ||= fakeApp;',
			'app ??= fakeApp;',
			"app.get('/real', realHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});
test('typescript-express: conditional top-level-looking reassignment does not invalidate the application binding', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app = express();',
			'if (flag) app = fakeApp;',
			"app.get('/real', realHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: definite reassignment after a semicolon-free braced statement invalidates the app binding', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app = express();',
			"app.get('/before', beforeHandler);",
			'function setup() {}',
			'app = fakeApp;',
			"app.get('/phantom-after-block', phantomHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /before']);
});
test('typescript-express: definite top-level destructuring reassignment invalidates a mutable application binding', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app = express();',
			"app.get('/before', beforeHandler);",
			'({ app } = config);',
			"app.get('/phantom-after-destructure', phantomHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /before']);
});
test('typescript-express: parameter decorators are skipped before resolving the shadow binding name', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			'class Holder {',
			'  constructor(@Inject(APP) app: FakeApp) {',
			"    app.get('/phantom-decorated-param', phantomHandler);",
			'  }',
			'}',
			"app.get('/real', realHandler);",
			"app.use('/api', router);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /real',
	]);
});
test('typescript-express: qualified receiver properties do not impersonate a trusted bare receiver', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const app = express();',
			'const router: Router = Router();',
			"router.get('/child', childHandler);",
			"app.get('/real', realHandler);",
			"APP.get('/phantom-uppercase', phantomHandler);",
			"app.use('/api', router);",
			"service.app.get('/phantom-service', phantomHandler);",
			"service.app.use('/wrong-service', router);",
			"this.app.get('/phantom-this', phantomHandler);",
			"éapp.get('/phantom-unicode-prefix', phantomHandler);",
			"this.#app.get('/phantom-private', phantomHandler);",
			'export default app;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /api/child',
		'GET /real',
	]);
});
test('typescript-express: keyword runtime operators after an assertion do not authorize fake applications', () => {
	for (const rhs of ['express() as any instanceof Fake', 'express() as any in fakeRegistry', 'express() as any ^ 0']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				`const app = ${rhs};`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, []);
	}
});

test('typescript-express: runtime conditional tails after an as-assertion do not authorize fake applications', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'const app = express() as any ? fakeApp : otherApp;',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: a definite write inside a standalone block invalidates a mutable application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'{ app = fakeApp; }',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: using declarations shadow an outer application receiver', () => {
	for (const declaration of ['using app = fakeApp;', 'await using app = fakeAsyncApp;']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'const app = express();',
				'async function configure() {',
				`  ${declaration}`,
				"  app.get('/phantom', phantomHandler);",
				'}',
				"app.get('/real', realHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints.map((e) => [e.verb, e.path]), [['GET', '/real']]);
	}
});

test('typescript-express: for-of writes affect loop-body calls but do not invalidate a post-loop application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (app of fakeApps) {',
			"  app.get('/phantom', phantomHandler);",
			'}',
			"app.get('/real-after-loop', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real-after-loop']);
});

test('typescript-express: definite top-level update expressions invalidate mutable applications', () => {
	for (const update of ['app++', '++app', 'app--', '--app']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				`${update};`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, []);
	}
});

test('typescript-express: exponentiation assignment invalidates a mutable application receiver', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'app **= 2;',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: var redeclaration initializer invalidates the existing mutable application receiver', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'var app: any = express();',
			'var app: any = fakeApp;',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: conditional update expressions do not invalidate a still-possible application receiver', () => {
	for (const update of ['app++', '++app', 'app--', '--app']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				`if (flag) ${update};`,
				"app.get('/real', realHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
	}
});

test('typescript-express: shift assignments invalidate mutable application receivers', () => {
	for (const operator of ['<<=', '>>=', '>>>=']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				`app ${operator} 2;`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, []);
	}
});

test('typescript-express: classic for var initializer invalidates an existing var application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'var app: any = express();',
			'for (var app: any = fakeApp; false;) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: direct update in an unconditional do body invalidates the application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'do { app++; } while (false);',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: semicolonless chained initializer is not mistaken for express() application value', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'const app: any = express()',
			'  .listen(3000);',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: classic for initializer assignment invalidates an existing mutable application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (app = fakeApp; false;) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: classic for assignment in a shadowed function does not invalidate the outer application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'function configure(app: any) {',
			'  for (app = fakeApp; false;) {}',
			'}',
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});
test('typescript-express: classic for var initializer inside an unconditional do body invalidates the application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'var app: any = express();',
			'do {',
			'  for (var app: any = fakeApp; false;) {}',
			'} while (false);',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});
test('typescript-express: an empty for-of loop preserves the application for post-loop routes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (app of []) {}',
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: classic for sequence initializer resolves the final assignment target', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (noop(), app = fakeApp; false;) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: named-specifier default imports preserve mounted router prefixes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			"import { default as child } from './child';",
			'const app = express();',
			'const rootRouter: Router = Router();',
			"app.use('/api', child);",
		].join('\n'),
		'src/child.ts': [
			"import { Router } from 'express';",
			'const childRouter: Router = Router();',
			"childRouter.get('/child', childHandler);",
			'export { childRouter as default };',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/child']);
});
test('typescript-express: statically nonempty for-of invalidates the application after the loop', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (app of [fakeApp]) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: classic for inspects every assignment in a sequence initializer', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (other = fake, app = fakeApp; false;) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: combined default-and-named imports preserve mounted router prefixes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			"import child, { helper } from './child';",
			'const app = express();',
			'const rootRouter: Router = Router();',
			"app.use('/api', child);",
		].join('\n'),
		'src/child.ts': [
			"import { Router } from 'express';",
			'const childRouter: Router = Router();',
			"childRouter.get('/child', childHandler);",
			'export default childRouter;',
			'export const helper = 1;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/child']);
});
test('typescript-express: array elisions still guarantee for-of writes before post-loop calls', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (app of [,]) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: __proto__ object literal does not falsely guarantee a for-in iteration', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (app in { __proto__: null }) {}',
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: classic-for authorization uses the selected assignment occurrence', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (noop((app) => app), app = fakeApp; false;) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: combined default-and-namespace imports preserve mounted router prefixes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			"import child, * as helpers from './child';",
			'const app = express();',
			'const rootRouter: Router = Router();',
			"app.use('/api', child);",
		].join('\n'),
		'src/child.ts': [
			"import { Router } from 'express';",
			'const childRouter: Router = Router();',
			"childRouter.get('/child', childHandler);",
			'export default childRouter;',
			'export const helper = 1;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/child']);
});
test('typescript-express: array holes do not guarantee a for-in iteration after the loop', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for (app in [,]) {}',
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: a nonempty string literal guarantees a for-of write before post-loop calls', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			"for (app of 'x') {}",
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});
test('typescript-express: grouped classic-for assignments still invalidate mutable applications', () => {
	for (const initializer of ['(app = fakeApp)', '((app = fakeApp))', 'noop(), (app = fakeApp)']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				`for (${initializer}; false;) {}`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, [], initializer);
	}
});
test('typescript-express: nonempty for-of inside a conditional or uncalled function does not invalidate an outer app', () => {
	for (const control of [
		"if (flag) for (app of [fakeApp]) {}",
		"function configure() { for (app of [fakeApp]) {} }",
	]) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				control,
				"app.get('/real', realHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real'], control);
	}
});

test('typescript-express: combined default-and-namespace Express import authorizes the application factory', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, * as expressHelpers from 'express';",
			"import { Router } from 'express';",
			'const router: Router = Router();',
			'const app = express();',
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: direct assignments in unconditional do bodies invalidate mutable applications', () => {
	for (const body of ['do { app = fakeApp; } while (false);', 'do app = fakeApp; while (false);']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				body,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, [], body);
	}
});

test('typescript-express: grouped classic-for sequences are re-split after peeling outer grouping', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'for ((noop(), app = fakeApp); false;) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});
test('typescript-express: unbraced do-body update invalidates a mutable application because it executes once', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'do app++; while (false);',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: finally-block assignment invalidates a mutable application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'try {} finally { app = fakeApp; }',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});
test('typescript-express: direct assignment in an unconditional try body invalidates the application', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'try { app = fakeApp; } finally {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: assignment chains invalidate the application at the inner target', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'other = app = fakeApp;',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: balanced grouping around update targets still invalidates the application', () => {
	for (const update of ['(app)++', '++(app)', '((app))--', '--((app))']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				`${update};`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, [], update);
	}
});
test('typescript-express: short-circuit logical assignment chains preserve a possibly unchanged app', () => {
	for (const statement of [
		'other ||= app = fakeApp;',
		'other &&= app = fakeApp;',
		'other ??= app = fakeApp;',
	]) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				'let other: any = true;',
				statement,
				"app.get('/real', realHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real'], statement);
	}
});

test('typescript-express: catchable try assignment does not invalidate the app after the try statement', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'try { app = mayThrow(); } catch {}',
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: updates in unconditional try bodies invalidate the app after a finally-only try', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			'try { app++; } finally {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});
test('typescript-express: ASI terminates an intervening call before a definite app reassignment', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express()',
			'cleanup()',
			'app = fakeApp',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: ASI handling preserves a newline-delimited conditional reassignment', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express()',
			'if (flag)',
			'  app = fakeApp',
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: compound unbraced control headers keep app reassignment conditional', () => {
	const variants = [
		[
			'if (a) cleanup()',
			'else if (b)',
			'  app = fakeApp',
		],
		[
			'if (a)',
			'  if (b)',
			'    app = fakeApp',
		],
		[
			'for await (const item of items)',
			'  app = fakeApp',
		],
	];
	for (const body of variants) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				...body,
				"app.get('/real', realHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
	}
});

test('typescript-express: other unbraced control headers keep app reassignment conditional, do-while stays definite', () => {
	const scanEndpoints = (body) => {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				...body,
				"app.get('/real', realHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		return result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints).map((e) => `${e.verb} ${e.path}`);
	};
	const conditional = [
		['while (x)', '  app = fakeApp'],
		['with (o)', '  app = fakeApp'],
		['if (a) cleanup()', 'else', '  app = fakeApp'],
		['if (a) cleanup()', 'else if (b) cleanup2()', 'else', '  app = fakeApp'],
		['outer:', '  if (a)', '    app = fakeApp'],
	];
	for (const body of conditional) assert.deepEqual(scanEndpoints(body), ['GET /real'], body.join(' / '));
	// A do-while body always runs at least once, so the reassignment is definite.
	assert.deepEqual(scanEndpoints(['do', '  app = fakeApp', 'while (x)']), []);
});

// Scans `let app: any = express(); <body> app.get('/real', ...)`. [] means the app binding was
// definitely replaced before the route; ['GET /real'] means the Express app may still be the receiver.
function scanBodyBeforeRoute(body) {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'let app: any = express();',
			...body,
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	return result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints).map((e) => `${e.verb} ${e.path}`);
}

// Compares every body in one assertion so a failure lists all wrong cases, not just the first.
function assertBodiesBeforeRoute(bodies, expected) {
	const actual = {};
	const wanted = {};
	for (const body of bodies) {
		const key = body.join(' / ');
		actual[key] = scanBodyBeforeRoute(body);
		wanted[key] = expected;
	}
	assert.deepEqual(actual, wanted);
}

test('typescript-express: a statement label before a definite app reassignment does not keep the old app trusted', () => {
	assertBodiesBeforeRoute([
		['lbl:', '  app = fakeApp'],
		['lbl: app = fakeApp'],
		['a1:', 'b1:', '  app = fakeApp'],
		['cleanup();', 'lbl:', '  app = fakeApp'],
		['cleanup()', 'lbl:', '  app = fakeApp'],
		['cleanup(); lbl: app = fakeApp'],
		['lbl:', '  cleanup(), app = fakeApp'],
		['lbl:', '  (app = fakeApp)'],
		['lbl:', '  ({ app } = { app: fakeApp })'],
		['lbl:', '  app++'],
		['lbl:', '  do { app = fakeApp } while (a)'],
		['lbl:', '  try { app = fakeApp } finally {}'],
		['lbl:', '  for (app of [fakeApp]) {}'],
		['{', '  lbl:', '    app = fakeApp', '}'],
		['lbl:', '  { app = fakeApp }'],
		['lbl: { app = fakeApp }'],
		['\u00e9t\u00e9: { app = fakeApp }'],
		['a\u200Db: { app = fakeApp }'],
		['lbl: {', '  app = fakeApp', '  other: { break other }', '}'],
		['lbl: // note', '  app = fakeApp'],
		['lbl: /* note */ app = fakeApp'],
		['$lbl:', '  app = fakeApp'],
		['_lbl:', '  app = fakeApp'],
		['\u00e9t\u00e9:', '  app = fakeApp'],
		['lbl: app += 1'],
		['lbl: [app] = [fakeApp]'],
		['if (a) cleanup();', 'lbl: { app = fakeApp }'],
		['{ cleanup() }', 'lbl: { app = fakeApp }'],
		['do lbl: app = fakeApp;', 'while (a);'],
		['do', '  lbl:', '  other:', '  app = fakeApp', 'while (a);'],
		['do lbl: app++;', 'while (a);'],
		['lbl: do app = fakeApp;', 'while (a);'],
		['lbl: do {', '  app = fakeApp', '} while (a);'],
		['do {', '  lbl: app = fakeApp', '} while (a);'],
	], []);
});

test('typescript-express: a statement label does not make a conditional app reassignment definite', () => {
	assertBodiesBeforeRoute([
		['lbl:', '  if (a)', '    app = fakeApp'],
		['lbl:', '  if (a) {', '    app = fakeApp', '  }'],
		['lbl:', '  while (a)', '    app = fakeApp'],
		['lbl:', '  app ||= fakeApp'],
		['if (a)', '  lbl:', '    app = fakeApp'],
		['if (a) lbl: app = fakeApp'],
		// A ternary colon is not a label.
		['a ?', '  b :', '  app = fakeApp'],
		['a', '  ? b', '  : app = fakeApp'],
		['a ? cleanup() :', '  app = fakeApp'],
		// `break <label>` can leave a labelled block before the write.
		['lbl: {', '  if (a) break lbl', '  app = fakeApp', '}'],
		['a1: b1: {', '  if (a) break a1', '  app = fakeApp', '}'],
		['\u00e9t\u00e9: {', '  if (a) break \u00e9t\u00e9', '  app = fakeApp', '}'],
		// The write must be the first statement of an inner block to be read as definite at all, so the
		// same `break <label>` guard is also checked with the write nested behind it.
		['lbl: {', '  if (a) break lbl;', '  { app = fakeApp }', '}'],
		['lbl: {', '  if (a) break lbl;', '  try { cleanup() } finally { app = fakeApp }', '}'],
		['lbl: {', '  if (a) break lbl;', '  do { app = fakeApp } while (b);', '}'],
		['a1: b1: {', '  if (a) break a1;', '  { app = fakeApp }', '}'],
		['a1: b1: {', '  if (a) break b1;', '  { app = fakeApp }', '}'],
		['\u00e9t\u00e9: {', '  if (a) break \u00e9t\u00e9;', '  { app = fakeApp }', '}'],
		// A labelled block only counts as a plain block when the label starts a statement.
		['if (a) lbl: { app = fakeApp }'],
		['while (a) lbl: { app = fakeApp }'],
		['if (a) cleanup()', 'else lbl: { app = fakeApp }'],
		['if (a) cleanup()', 'else lbl: app = fakeApp'],
		['lbl: for (const item of items)', '  app = fakeApp'],
		['lbl: while (a)', '  app = fakeApp'],
		['lbl: if (a)', '  app = fakeApp'],
		['switch (a) {', '  case 1: {', '    app = fakeApp', '  }', '}'],
		['switch (a) {', '  case 1:', '    lbl: app = fakeApp', '}'],
		['const run = () => {', '  lbl: {', '    app = fakeApp', '  }', '}'],
		['do lbl: if (a) app = fakeApp;', 'while (b);'],
	], ['GET /real']);
});

test('typescript-express: keyword-named members and identifiers are not control headers before a definite app reassignment', () => {
	assertBodiesBeforeRoute([
		['promise.catch(handle)', 'app = fakeApp'],
		['promise?.catch(handle)', 'app = fakeApp'],
		['promise. catch(handle)', 'app = fakeApp'],
		['promise', '  .catch(handle)', 'app = fakeApp'],
		['promise.', '  catch(handle)', 'app = fakeApp'],
		["const k = Symbol.for('k')", 'app = fakeApp'],
		['const arr2 = arr.with(0, 1)', 'app = fakeApp'],
		['$if(cond)', 'app = fakeApp'],
		['xo.while(a)', 'app = fakeApp'],
		['xo.switch(a)', 'app = fakeApp'],
		['xo.if(a)', 'app = fakeApp'],
		['const run = obj.do', 'app = fakeApp'],
		['const run2 = obj.else', 'app = fakeApp'],
		['promise.catch(handle)', 'app++'],
		['xo?.while(a)', 'app = fakeApp'],
		['xo. /* note */ if(cond)', 'app = fakeApp'],
		['obj?.do', 'app = fakeApp'],
		['obj. else', 'app = fakeApp'],
		['obj.', '  else', 'app = fakeApp'],
		['function \u00e9if(c) { return c }', '\u00e9if(cond)', 'app = fakeApp'],
		['function a\u200Dif(c) { return c }', 'a\u200Dif(cond)', 'app = fakeApp'],
		['obj.do', 'do app = fakeApp;', 'while (a);'],
		['obj?.do', 'do', '  app = fakeApp', 'while (a);'],
	], []);
});

test('typescript-express: real control keywords keep their classification next to keyword-named members', () => {
	assertBodiesBeforeRoute([
		['if (a)', '  app = fakeApp'],
		['while (a)', '  app = fakeApp'],
		['for (const item of items)', '  app = fakeApp'],
		['cleanup();', 'if (a)', '  app = fakeApp'],
		['{ cleanup() }', 'if (a)', '  app = fakeApp'],
		['if (a) cleanup()', 'else', '  app = fakeApp'],
		['if (a) cleanup();', 'else if (b)', '  app = fakeApp'],
	], ['GET /real']);
	assertBodiesBeforeRoute([
		['const notif = 1', 'app = fakeApp'],
		['promise.then(handle)', 'app = fakeApp'],
		['if (a) cleanup()', 'else if (b) cleanup()', 'app = fakeApp'],
		['try { cleanup() } finally {}', 'app = fakeApp'],
	], []);
});

// A control keyword is a whole token: `if$x` and `while\u00e9` are plain identifiers, so a chained write that
// starts with one of them still definitely replaces the app. A leading label must not change that.
test('typescript-express: keyword-prefixed identifiers at the start of a chained write do not hide the app reassignment', () => {
	assertBodiesBeforeRoute([
		['let x', 'x = app = fakeApp'],
		['let if$x', 'if$x = app = fakeApp'],
		['let for$x', 'for$x = app = fakeApp'],
		['let while$x', 'while$x = app = fakeApp'],
		['let with$x', 'with$x = app = fakeApp'],
		['let switch$x', 'switch$x = app = fakeApp'],
		['let if\u00e9', 'if\u00e9 = app = fakeApp'],
		['let while\u00e9', 'while\u00e9 = app = fakeApp'],
		['let if\u200Dx', 'if\u200Dx = app = fakeApp'],
		['let if$x;', '(if$x = app = fakeApp)'],
		['let if$x, y', 'if$x = y = app = fakeApp'],
		['let if$x', 'cleanup();', 'if$x = app = fakeApp'],
		['let if$x; if$x = app = fakeApp;'],
		['let if$x', 'lbl: if$x = app = fakeApp'],
		['let if$x;', '{', 'if$x = app = fakeApp', '}'],
	], []);
	assertBodiesBeforeRoute([
		['let x', 'if (a) x = app = fakeApp'],
		['let x', 'if(a) x = app = fakeApp'],
		['let x', 'while (a) x = app = fakeApp'],
		['let x', 'for (const i of items) x = app = fakeApp'],
		['let x', 'for await (const i of items) x = app = fakeApp'],
		['let if$x', 'if (a) if$x = app = fakeApp'],
		['let if$x', 'if (a)', '  if$x = app = fakeApp'],
	], ['GET /real']);
});

// Pins current behaviour, not the ideal one: a newline right after `for` ends the statement, so the
// later `await (...)` header is not recognised and the loop body reads as a definite statement.
// The route is dropped (fail-closed) although the write is conditional.
test('typescript-express: for + newline + await header currently drops the route while the other for-await layouts stay conditional', () => {
	assertBodiesBeforeRoute([
		['for', 'await (const item of items)', '  app = fakeApp'],
		['for', '  await', '  (const item of items)', '  app = fakeApp'],
	], []);
	assertBodiesBeforeRoute([
		['for await (const item of items)', '  app = fakeApp'],
		['for await', '(const item of items)', '  app = fakeApp'],
		['for await(const item of items) app = fakeApp'],
		['for await (const item of items) app = fakeApp'],
		['for (const item of items)', '  app = fakeApp'],
	], ['GET /real']);
	// A write after the loop is definite whichever way the header is broken across lines.
	assertBodiesBeforeRoute([
		['for await (const item of items) cleanup()', 'app = fakeApp'],
		['for', 'await (const item of items) cleanup()', 'app = fakeApp'],
	], []);
});

// Pins current behaviour, not the ideal one: the `\\b` in topLevelSequenceAssignmentTarget is a
// literal backslash + b and never matches, so `if (a) cleanup(), app = x` is read as the definite
// sequence `cleanup(), app = x`. The route is dropped (fail-closed) although the write is conditional.
test('typescript-express: a comma-sequence write under an if/while header currently drops the route', () => {
	assertBodiesBeforeRoute([
		['if (a) cleanup(), app = fakeApp'],
		['while (a) cleanup(), app = fakeApp'],
		['lbl:', '  if (a) cleanup(), app = fakeApp'],
	], []);
});

// Pins current behaviour, not the ideal one: a `finally` block is read as a definite scope even when
// the `try` is the unbraced body of an if/while/else, so the route is dropped (fail-closed) although
// the write is conditional. A leading label reads exactly like no label.
test('typescript-express: a finally write under an unbraced control header currently drops the route, labelled or not', () => {
	assertBodiesBeforeRoute([
		['if (a)', '  try { cleanup() } finally { app = fakeApp }'],
		['if (a)', '  try { cleanup() } finally { lbl: app = fakeApp }'],
		['while (a)', '  try { cleanup() } finally { app = fakeApp }'],
		['if (a) cleanup()', 'else', '  try { cleanup() } finally { lbl: app = fakeApp }'],
	], []);
});

test('typescript-express: initializer-free var redeclaration in a classic for preserves the trusted app', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'var app: any = express();',
			'for (var app; false;) {}',
			"app.get('/real', realHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: initialized var redeclaration in a classic for still invalidates the trusted app', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'const router: Router = Router();',
			'var app: any = express();',
			'for (var app = fakeApp; false;) {}',
			"app.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: operator-led next lines remain part of a semicolonless initializer', () => {
	for (const continuation of ['&& fakeApp', '|| fakeApp', '?? fakeApp']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'const app: any = express()',
				`  ${continuation};`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, [], continuation);
	}
});

test('typescript-express: in/of inside classic-for initializer expressions are not loop separators', () => {
	for (const initializer of ["app = ('x' in {})", "app = includes('of')"]) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				`for (${initializer}; false;) {}`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, [], initializer);
	}
});
test('typescript-express: equality operators on the next line remain part of semicolonless initializers', () => {
	for (const continuation of ['!== fakeApp', '=== fakeApp', '!= fakeApp', '== fakeApp']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'const app: any = express()',
				`  ${continuation};`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, [], continuation);
	}
});

test('typescript-express: classic-for assignment chains inspect every guaranteed nested target', () => {
	for (const initializer of ['other = app = fakeApp', 'first = second = app = fakeApp']) {
		const root = writeTree({
			'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
			'tsconfig.json': '{}',
			'src/server.ts': [
				"import express, { Router } from 'express';",
				'const router: Router = Router();',
				'let app: any = express();',
				`for (${initializer}; false;) {}`,
				"app.get('/phantom', phantomHandler);",
			].join('\n'),
		});
		const projectRoot = detectTypeScriptExpressRoot(root);
		assert.ok(projectRoot);
		const result = scanTypeScriptExpress(root, projectRoot);
		const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
		assert.deepEqual(endpoints, [], initializer);
	}
});
test('typescript-express: deferred function bodies may capture receivers declared later in an outer scope', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'function registerRouter() {',
			"  router.get('/router-real', routerHandler);",
			'}',
			'function registerApp() {',
			"  app.get('/app-real', appHandler);",
			'}',
			'const router: Router = Router();',
			'const app = express();',
			'registerRouter();',
			'registerApp();',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), ['GET /app-real', 'GET /router-real']);
});

test('typescript-express: a later receiver in the same executing function remains unauthorized before initialization', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import express, { Router } from 'express';",
			'function register() {',
			"  router.get('/phantom', phantomHandler);",
			'  const router: Router = Router();',
			'}',
			'const rootRouter: Router = Router();',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints, []);
});

test('typescript-express: var Router declarations remain authorized inside their textual nested block', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/server.ts': [
			"import { Router } from 'express';",
			'{',
			'  var router: Router = Router();',
			"  router.get('/inside', insideHandler);",
			'}',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /inside']);
});
test('typescript-express: an unrelated callable is not treated as an Express application receiver', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes.ts': [
			"import express, { Router } from 'express';",
			"import toolkit from 'toolkit';",
			'const router: Router = Router();',
			"router.get('/real', realHandler);",
			'const application = toolkit();',
			"application.get('/phantom', phantomHandler);",
			'const configuredApplication = express(config);',
			"configuredApplication.get('/also-phantom', phantomHandler);",
			'export default router;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot);
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /real']);
});

test('typescript-express: named Express import text inside a string cannot authorize a fake Router factory', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/fake.ts': [
			"const docs = \"import { Router } from 'express'\";",
			'function Router() { return fakeApi; }',
			'const router = Router();',
			"router.get('/phantom', phantomHandler);",
		].join('\n'),
	});
	assert.equal(detectTypeScriptExpressRoot(root), null);
});
test('typescript-express: an Express Router type import does not authorize an unrelated .Router factory', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/real.ts': [
			"import { Router } from 'express';",
			'const router = Router();',
			"router.get('/real', realHandler);",
			'export default router;',
		].join('\n'),
		'src/routes/fake.ts': [
			"import { Router } from 'express';",
			"import toolkit from 'toolkit';",
			'const fakeRouter: Router = toolkit.Router();',
			"fakeRouter.get('/phantom', phantomHandler);",
			'export default fakeRouter;',
		].join('\n'),
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	assert.ok(projectRoot, 'the legitimate Express router still detects the project');
	const result = scanTypeScriptExpress(root, projectRoot);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => e.verb + ' ' + e.path), ['GET /real']);
});

test('javascript-express: a router declared as express.Router({ mergeParams: true }) is still detected and scanned', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'src/routes/things.route.js': [
			"import express from 'express';",
			'const router = express.Router({ mergeParams: true });',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
	});
	const detection = detectJavaScriptExpressRoot(root);
	assert.ok(detection, 'a Router({...}) declaration must still satisfy detect()');
	const result = scanJavaScriptExpress(root, detection);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /:id']);
});

// Semicolon-less ESM (standard.js style) is entirely ordinary, and a forward
// `import\s+([^;]*?)\s*from\s*['"]express['"]` runs straight through the PREVIOUS import statement
// on it, yielding a clause like `cors from 'cors'\nimport express` and silently losing the default
// binding name -- which loses every `express()` application, and with it any global prefix mounted
// on one. Also covers a clause spread over several lines.
test('javascript-express: semicolon-less and multi-line express imports still bind correctly', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'src/app.js': [
			"import cors from 'cors'",
			"import express, {",
			'  Router',
			"} from 'express'",
			"import thingRoute from './routes/thing.route.js'",
			'const app = express()',
			'const route = Router()',
			'app.use(cors())',
			"route.use('/thing', thingRoute)",
			"app.use('/api', route)",
			'export default app',
		].join('\n'),
		'src/routes/thing.route.js': [
			"import express from 'express'",
			'const router = express.Router()',
			"router.get('/:id', showThing)",
			'export default router',
		].join('\n'),
	});
	const detection = detectJavaScriptExpressRoot(root);
	assert.ok(detection, 'a semicolon-less repo must still be detected');
	const result = scanJavaScriptExpress(root, detection);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	// The full prefix chain only resolves if BOTH the multi-line `express, { Router }` clause and
	// the semicolon-less `import express from 'express'` in the leaf file parsed correctly.
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/thing/:id']);
});

// The exact shape that broke the G6 adapter's whole mount graph while it was being written: prose
// in a header comment quoting an import statement, which an unmasked
// `import\s+([^;]*?)\s*from\s*['"]express['"]` matched across a newline into the real statement.
test('javascript-express: prose quoting an express import in a comment does not corrupt binding detection', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'src/routes/things.route.js': [
			"// Unlike the TS adapter, which looks for `import { Router } from 'express'`, this file",
			'// uses the default-import idiom instead -- no import involved at all in the comment.',
			"import express from 'express';",
			'const router = express.Router();',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
	});
	const detection = detectJavaScriptExpressRoot(root);
	assert.ok(detection, 'fixture must still be detected despite the comment');
	const result = scanJavaScriptExpress(root, detection);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /:id']);
});

// D-module-attribution-base-package (Update): found by the same shadow-validation pass that fixed
// java-spring's own moduleOf() -- a real project not using a dto/ folder at all had every DTO silently invisible.
// This adapter's own DTO detection stayed purely path-convention-based (dto/) since java-spring's
// identical convention; the fallback here adds a second, independent NAME-only signal (basename
// ends in "dto"), not a content parser -- see the comment above DTO_NAME_SUFFIX_RE in
// typescript-express.mjs for why content-based detection is still deliberately not attempted.
test('typescript-express: a DTO file with no "dto/" folder at all (PascalCase UserDto.ts) is still detected and attached to its module', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/users.ts': [
			"import { Router } from 'express';",
			'const router = Router();',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
		'src/UserDto.ts': 'export interface UserDto { name: string; }',
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	const result = scanTypeScriptExpress(root, projectRoot);
	const usersModule = result.modules.find((m) => m.module === 'users');
	assert.ok(usersModule, 'expected a "users" module');
	const dto = usersModule.dtos.find((d) => d.className === 'UserDto');
	assert.ok(dto, 'expected UserDto to be found and attached to "users", even without a dto/ folder');
});

test('typescript-express: a DTO file with no "dto/" folder at all (NestJS-style kebab-case user.dto.ts) is still detected', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/users.ts': [
			"import { Router } from 'express';",
			'const router = Router();',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
		'src/user.dto.ts': 'export interface UserDto { name: string; }',
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	const result = scanTypeScriptExpress(root, projectRoot);
	const allDtos = result.modules.flatMap((m) => m.dtos);
	assert.ok(allDtos.some((d) => d.className === 'user.dto'), 'expected user.dto.ts to be found by its own basename, even kebab-cased');
});

test('typescript-express: a plain, unrelated .ts file (no dto/ folder, name does not end in "dto") is never misdetected as a DTO', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', dependencies: { express: '^4.18.2' } }),
		'tsconfig.json': '{}',
		'src/routes/users.ts': [
			"import { Router } from 'express';",
			'const router = Router();',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
		'src/config.ts': 'export const config = { port: 3000 };',
	});
	const projectRoot = detectTypeScriptExpressRoot(root);
	const result = scanTypeScriptExpress(root, projectRoot);
	const allDtos = result.modules.flatMap((m) => m.dtos);
	assert.deepEqual(allDtos, [], 'config.ts must never be misdetected as a DTO');
});

// D-javascript-express-adapter (Update): found by the same audit that closed
// D-module-attribution-base-package's EXIT item for this adapter -- cross-file mount resolution
// only ever recognized `export default router;`; a router handed off via a bare named export or an
// export-prefixed declaration was invisible to the mount graph, silently dropping its real prefix.
test('javascript-express: a router exported via "export const router = Router()" (export-prefixed declaration) and imported via a named import still resolves its real prefix', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'app.js': [
			"import express from 'express';",
			"import { userRouter } from './users.js';",
			'const app = express();',
			"app.use('/api', userRouter);",
		].join('\n'),
		'users.js': [
			"import express from 'express';",
			'export const userRouter = express.Router();',
			"userRouter.get('/:id', show);",
		].join('\n'),
	});
	const detection = detectJavaScriptExpressRoot(root);
	assert.ok(detection, 'fixture must be detected');
	const result = scanJavaScriptExpress(root, detection);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/:id'], 'the /api prefix from app.js must reach the named-imported, export-prefixed-declared router');
});

test('javascript-express: a router declared separately then re-exported via a bare "export { router }" and imported via a named import still resolves its real prefix', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'app.js': [
			"import express from 'express';",
			"import { userRouter } from './users.js';",
			'const app = express();',
			"app.use('/api', userRouter);",
		].join('\n'),
		'users.js': [
			"import express from 'express';",
			'const userRouter = express.Router();',
			"userRouter.get('/:id', show);",
			'export { userRouter };',
		].join('\n'),
	});
	const detection = detectJavaScriptExpressRoot(root);
	assert.ok(detection, 'fixture must be detected');
	const result = scanJavaScriptExpress(root, detection);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/:id'], 'the /api prefix from app.js must reach the bare-named-exported router');
});

// D-javascript-express-member-handlers-middleware-mounts: the two idioms a real production plain-JS
// backend (serverless Lambda, raw mysql2) uses for nearly every route, which together hid 221 of
// its 227 routes and made `bskel scan --feature` report a false `greenfield`:
//   1. `import * as ctrl from '...'` + `router.post('/', ctrl.create)` -- member-expression handler
//   2. `route.use('/reservations', LoginCheck, reservationRoute)` -- auth middleware before the router
test('javascript-express: member-expression handlers are recorded verbatim and middleware-guarded mounts keep their prefix', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'src/app.js': [
			"import express from 'express';",
			"import routes from './routes/index.js';",
			'const app = express();',
			'app.use(express.json());',
			'app.use(routes);',
			'export default app;',
		].join('\n'),
		'src/routes/index.js': [
			"import express from 'express';",
			"import userRoute from './user/index.js';",
			'const route = express.Router({ mergeParams: true });',
			"route.use('/user', userRoute);",
			'export default route;',
		].join('\n'),
		'src/routes/user/index.js': [
			"import express from 'express';",
			"import reservationRoute from './reservation.js';",
			"import shopRoute from './shop.js';",
			"import { LoginCheck, RoleCheck } from '../../middlewares/auth.js';",
			'const route = express.Router({ mergeParams: true });',
			"route.use('/reservations', LoginCheck, reservationRoute);",
			"route.use('/shops', LoginCheck, RoleCheck('USER'), shopRoute);",
			'export default route;',
		].join('\n'),
		'src/routes/user/reservation.js': [
			"import { Router } from 'express';",
			"import * as reservationController from '../../controllers/reservation.js';",
			'const router = Router({ mergeParams: true });',
			"router.post('/', reservationController.createReservation);",
			"router.post('/:id/cancel', LoginCheck, reservationController . cancelReservation);",
			'export default router;',
		].join('\n'),
		'src/routes/user/shop.js': [
			"import { Router } from 'express';",
			"import * as shopController from '../../controllers/shop.js';",
			'const router = Router();',
			"router.get('/likes', shopController.getLikes);",
			'export default router;',
		].join('\n'),
		'src/middlewares/auth.js': 'export const LoginCheck = (req, res, next) => next();\nexport const RoleCheck = () => (req, res, next) => next();\n',
	});
	const detection = detectJavaScriptExpressRoot(root);
	assert.ok(detection, 'fixture must be detected');
	const result = scanJavaScriptExpress(root, detection);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path} ${e.method}`).sort(), [
		'GET /user/shops/likes shopController.getLikes',
		'POST /user/reservations reservationController.createReservation',
		'POST /user/reservations/:id/cancel reservationController.cancelReservation',
	].sort());
});

// Middleware positions are now mount CANDIDATES, so a named import must bind only the export of
// that same name -- never "whatever router the module happens to export".
test('javascript-express: a named-imported middleware from a module that also exports a router is not mistaken for that router', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'app.js': [
			"import express from 'express';",
			"import { guard } from './guarded.js';",
			"import things from './things.js';",
			'const app = express();',
			"app.use('/api', guard, things);",
		].join('\n'),
		'guarded.js': [
			"import express from 'express';",
			'const adminRouter = express.Router();',
			"adminRouter.get('/secret', showSecret);",
			'export const guard = (req, res, next) => next();',
			'export default adminRouter;',
		].join('\n'),
		'things.js': [
			"import express from 'express';",
			'const router = express.Router();',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
	});
	const detection = detectJavaScriptExpressRoot(root);
	const result = scanJavaScriptExpress(root, detection);
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), ['GET /api/:id', 'GET /secret'], 'adminRouter is never mounted, so it must NOT inherit /api through the guard middleware');
});

test('javascript-express: a default-imported middleware never falls through to a named-exported router', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'app.js': [
			"import express from 'express';",
			"import guard from './guarded.js';",
			"import things from './things.js';",
			'const app = express();',
			"app.use('/api', guard, things);",
		].join('\n'),
		'guarded.js': [
			"import express from 'express';",
			'const adminRouter = express.Router();',
			"adminRouter.get('/secret', showSecret);",
			'const guard = (req, res, next) => next();',
			'export { adminRouter };',
			'export default guard;',
		].join('\n'),
		'things.js': [
			"import express from 'express';",
			'const router = express.Router();',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
	});
	const result = scanJavaScriptExpress(root, detectJavaScriptExpressRoot(root));
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), ['GET /api/:id', 'GET /secret'], 'default middleware must not mount the unrelated named adminRouter under /api');
});

test('javascript-express: an aliased named export never binds an unrelated same-named local router', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'app.js': [
			"import express from 'express';",
			"import { guard } from './guarded.js';",
			"import things from './things.js';",
			'const app = express();',
			"app.use('/api', guard, things);",
		].join('\n'),
		'guarded.js': [
			"import express from 'express';",
			'const guard = express.Router();',
			"guard.get('/secret', showSecret);",
			'const middleware = (req, res, next) => next();',
			'export { middleware as guard };',
		].join('\n'),
		'things.js': [
			"import express from 'express';",
			'const router = express.Router();',
			"router.get('/:id', show);",
			'export default router;',
		].join('\n'),
	});
	const result = scanJavaScriptExpress(root, detectJavaScriptExpressRoot(root));
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), ['GET /api/:id', 'GET /secret'], 'export { middleware as guard } must not make the local guard router inherit /api');
});

test('javascript-express: member-expression handlers reject computed or interpolated endpoint paths', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'r.js': [
			"import express from 'express';",
			'const router = express.Router();',
			"const suffix = '/v1';",
			"router.get('/users' + suffix, ctrl.listUsers);",
			"router.get(`/teams/${suffix}`, ctrl.listTeams);",
			"router.get('/static', ctrl.listStatic);",
			'export default router;',
		].join('\n'),
	});
	const result = scanJavaScriptExpress(root, detectJavaScriptExpressRoot(root));
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path} ${e.method}`), [
		'GET /static ctrl.listStatic',
	]);
});

test('javascript-express: multi-handler mounts reject computed or interpolated path prefixes', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'app.js': [
			"import express from 'express';",
			"import concatRouter from './concat.js';",
			"import templateRouter from './template.js';",
			'const app = express();',
			"const suffix = '/v1';",
			'const guard = (req, res, next) => next();',
			"app.use('/api' + suffix, guard, concatRouter);",
			"app.use(`/api/${suffix}`, guard, templateRouter);",
		].join('\n'),
		'concat.js': [
			"import express from 'express';",
			'const router = express.Router();',
			"router.get('/concat', show);",
			'export default router;',
		].join('\n'),
		'template.js': [
			"import express from 'express';",
			'const router = express.Router();',
			"router.get('/template', show);",
			'export default router;',
		].join('\n'),
	});
	const result = scanJavaScriptExpress(root, detectJavaScriptExpressRoot(root));
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`).sort(), [
		'GET /concat',
		'GET /template',
	]);
});

test('javascript-express: grouped named imports preserve the mounted router prefix', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'app.js': [
			"import express from 'express';",
			"import { guard, things } from './routes.js';",
			'const app = express();',
			"app.use('/api', guard, things);",
		].join('\n'),
		'routes.js': [
			"import express from 'express';",
			'const things = express.Router();',
			"things.get('/:id', show);",
			'const guard = (req, res, next) => next();',
			'export { guard, things };',
		].join('\n'),
	});
	const result = scanJavaScriptExpress(root, detectJavaScriptExpressRoot(root));
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /api/:id']);
});

test('javascript-express: computed or call-expression handlers are still skipped, not guessed at', () => {
	const root = writeTree({
		'package.json': JSON.stringify({ name: 'x', type: 'module', dependencies: { express: '^4.18.2' } }),
		'r.js': [
			"import express from 'express';",
			'const router = express.Router();',
			"router.get('/a', ctrl['show']);",
			"router.get('/b', wrap(ctrl.show));",
			"router.get('/c', ctrl.show);",
			'export default router;',
		].join('\n'),
	});
	const result = scanJavaScriptExpress(root, detectJavaScriptExpressRoot(root));
	const endpoints = result.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
	assert.deepEqual(endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /c']);
});
