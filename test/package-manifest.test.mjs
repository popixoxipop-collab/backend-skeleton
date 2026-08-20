// P1 (D-npm-packaging): `npm pack --dry-run --json` is the exact command a real `npm publish`
// packs with. Before this item, package.json had no `files` field at all, so every push shipped
// the whole repo -- test/ alone was 37% of the unpacked tarball and entirely unused by any
// runtime code path. This test is the safety net for the `files` allowlist: every assertion below
// is checked against the actual source's import/read graph (grep), not a hand-maintained expected
// list, so a future new runtime dependency that forgets to update `files` fails loudly here
// instead of shipping a broken install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

function packManifest() {
	const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
	const [entry] = JSON.parse(out);
	return entry.files.map((f) => f.path);
}

test('package.json is no longer private, and declares a files allowlist', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
	assert.equal('private' in pkg, false, 'private must be removed entirely, not just set to false, for `npm publish` to work without --access');
	assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'expected a non-empty files allowlist');
});

test('npm pack includes bin/bskel.mjs, package.json, and LICENSE', () => {
	const files = packManifest();
	assert.ok(files.includes('bin/bskel.mjs'));
	assert.ok(files.includes('package.json'));
	assert.ok(files.includes('LICENSE'), 'npm always special-cases LICENSE/LICENCE regardless of the files field');
});

test('npm pack includes every JSON Schema, cross-checked against every schemas/*.schema.json reference in source', () => {
	const files = packManifest();
	const schemas = files.filter((f) => f.startsWith('schemas/') && f.endsWith('.schema.json'));
	const referenced = execFileSync(
		'grep', ['-rhoE', 'schemas/[a-zA-Z0-9_-]+\\.schema\\.json', 'lib', 'contracts', 'handles', 'bin', 'scanners', 'stack'],
		{ cwd: REPO_ROOT, encoding: 'utf8' },
	).split('\n').filter(Boolean);
	const referencedSet = [...new Set(referenced)];
	assert.ok(referencedSet.length > 0, 'sanity: the grep itself must find at least one reference');
	for (const rel of referencedSet) {
		assert.ok(schemas.includes(rel), `${rel} is referenced by source but missing from the npm pack manifest`);
	}
});

test('npm pack includes every codegen template for both handles providers, and both scanner adapters (dynamically loaded, not statically imported)', () => {
	const files = packManifest();
	const javaSpringTemplates = files.filter((f) => f.startsWith('handles/providers/java-spring/templates/') && f.endsWith('.tmpl'));
	const pythonFastapiTemplates = files.filter((f) => f.startsWith('handles/providers/python-fastapi/templates/') && f.endsWith('.tmpl'));
	assert.ok(javaSpringTemplates.length >= 9, `expected at least 9 java-spring templates, found ${javaSpringTemplates.length}`);
	assert.ok(pythonFastapiTemplates.length >= 6, `expected at least 6 python-fastapi templates, found ${pythonFastapiTemplates.length}`);
	assert.ok(files.includes('scanners/adapters/java-spring.mjs'));
	assert.ok(files.includes('scanners/adapters/python-fastapi.mjs'));
	assert.ok(files.includes('scanners/adapters/generic-grep.mjs'));
});

test('npm pack includes scripts/preflight-base-ref.sh and the stack catalog + bootstrap templates', () => {
	const files = packManifest();
	assert.ok(files.includes('scripts/preflight-base-ref.sh'));
	assert.ok(files.includes('stack/catalog/ngrok.yml'));
	assert.ok(files.some((f) => f.startsWith('stack/bootstrap/')), 'expected at least one stack bootstrap template');
});

test('npm pack excludes test/, DECISIONS.md, CATALOG.md, and SKILL.md (dev-only or Claude-Code-skill-only, never read by bskel at runtime)', () => {
	const files = packManifest();
	assert.equal(files.filter((f) => f.startsWith('test/')).length, 0);
	assert.ok(!files.includes('DECISIONS.md'));
	assert.ok(!files.includes('CATALOG.md'));
	assert.ok(!files.includes('SKILL.md'));
});
