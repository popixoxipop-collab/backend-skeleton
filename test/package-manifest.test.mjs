// P3 (D-fixture-corpus): `npm pack --dry-run --json` is the exact command
// scripts/pack-install-smoke.sh's real install is built on -- this test is the fast, offline half
// (no tarball, no install, just the manifest npm itself would publish) and the safety net for
// P1's eventual `files` allowlist: whenever that lands, this test is what proves it didn't
// accidentally drop a runtime-required asset (a schema, a codegen template, the preflight script,
// a stack catalog entry) while trimming the currently-unrestricted "ships the whole repo" default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

function packManifest() {
	const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
	const [entry] = JSON.parse(out);
	return entry.files.map((f) => f.path);
}

test('npm pack includes bin/bskel.mjs and package.json', () => {
	const files = packManifest();
	assert.ok(files.includes('bin/bskel.mjs'));
	assert.ok(files.includes('package.json'));
});

test('npm pack includes every JSON Schema this tool loads at runtime', () => {
	const files = packManifest();
	const schemas = files.filter((f) => f.startsWith('schemas/') && f.endsWith('.schema.json'));
	// Cross-checked against every distinct schemas/*.schema.json path referenced anywhere in
	// lib/**, contracts/**, handles/** via a live grep, not a hand-maintained list here -- if a
	// future schema is added and referenced but never shipped, this test must fail, not silently
	// pass because its own expected-list forgot the new one too.
	const referenced = execFileSync(
		'grep', ['-rhoE', "schemas/[a-zA-Z0-9_-]+\\.schema\\.json", 'lib', 'contracts', 'handles', 'bin'],
		{ cwd: REPO_ROOT, encoding: 'utf8' },
	).split('\n').filter(Boolean);
	const referencedSet = [...new Set(referenced)];
	assert.ok(referencedSet.length > 0, 'sanity: the grep itself must find at least one reference');
	for (const rel of referencedSet) {
		assert.ok(schemas.includes(rel), `${rel} is referenced by source but missing from the npm pack manifest`);
	}
});

test('npm pack includes every codegen template for both handles providers', () => {
	const files = packManifest();
	const javaSpringTemplates = files.filter((f) => f.startsWith('handles/providers/java-spring/templates/') && f.endsWith('.tmpl'));
	const pythonFastapiTemplates = files.filter((f) => f.startsWith('handles/providers/python-fastapi/templates/') && f.endsWith('.tmpl'));
	assert.ok(javaSpringTemplates.length >= 9, `expected at least 9 java-spring templates, found ${javaSpringTemplates.length}`);
	assert.ok(pythonFastapiTemplates.length >= 6, `expected at least 6 python-fastapi templates, found ${pythonFastapiTemplates.length}`);
});

test('npm pack includes scripts/preflight-base-ref.sh and the stack catalog', () => {
	const files = packManifest();
	assert.ok(files.includes('scripts/preflight-base-ref.sh'));
	assert.ok(files.includes('stack/catalog/ngrok.yml'));
	assert.ok(files.some((f) => f.startsWith('stack/bootstrap/')), 'expected at least one stack bootstrap template');
});
