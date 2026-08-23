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
