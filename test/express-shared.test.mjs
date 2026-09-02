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
