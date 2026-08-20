import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');
const CATALOG_DIR = path.join(__dirname, '..', 'stack', 'catalog');
const BOOTSTRAP_DIR = path.join(__dirname, '..', 'stack', 'bootstrap');

function run(args) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// Writes a throwaway catalog fixture (and optionally a template) directly into the real
// stack/catalog//stack/bootstrap dirs -- there is no other way to exercise loadCatalogEntry's
// real STACK_ROOT-relative resolution (same technique as stack-cli.test.mjs's D-security-4
// traversal regression test) -- and always cleans up, even if an assertion throws.
function withCatalogFixture(id, yamlBody, templateFiles, fn) {
	const catalogPath = path.join(CATALOG_DIR, `${id}.yml`);
	const writtenTemplates = [];
	try {
		fs.writeFileSync(catalogPath, yamlBody);
		for (const [relPath, content] of Object.entries(templateFiles ?? {})) {
			const templatePath = path.join(BOOTSTRAP_DIR, relPath);
			fs.writeFileSync(templatePath, content);
			writtenTemplates.push(templatePath);
		}
		fn();
	} finally {
		fs.rmSync(catalogPath, { force: true });
		for (const p of writtenTemplates) fs.rmSync(p, { force: true });
	}
}

test('catalog lint (no args) passes for the real ngrok catalog entry', () => {
	const result = run(['catalog', 'lint', '--json']);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const results = JSON.parse(result.stdout);
	const ngrok = results.find((r) => r.choice === 'ngrok');
	assert.ok(ngrok, 'ngrok must be included when no choice is given');
	assert.equal(ngrok.ok, true);
	assert.deepEqual(ngrok.errors, []);
});

test('catalog lint <choice> lints only that one choice', () => {
	const result = run(['catalog', 'lint', 'ngrok', '--json']);
	assert.equal(result.code, 0);
	const results = JSON.parse(result.stdout);
	assert.equal(results.length, 1);
	assert.equal(results[0].choice, 'ngrok');
});

test('catalog lint <unknown-choice> fails with the list of known choices', () => {
	const result = run(['catalog', 'lint', 'not-a-real-choice']);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /unknown stack choice "not-a-real-choice"/);
	assert.match(result.stderr, /ngrok/);
});

test('catalog lint reports a schema-invalid catalog entry (missing required "runtime")', () => {
	withCatalogFixture(
		'zz-lint-schema-bad',
		`id: zz-lint-schema-bad\ndescription: "fixture"\nstatic:\n  files: []\n`,
		{},
		() => {
			const result = run(['catalog', 'lint', 'zz-lint-schema-bad', '--json']);
			assert.equal(result.code, 1);
			const [entry] = JSON.parse(result.stdout);
			assert.equal(entry.ok, false);
			assert.match(entry.errors[0], /does not match schemas\/stack-choice\.schema\.json/);
			assert.match(entry.errors[0], /runtime/);
		},
	);
});

test('catalog lint reports a template path that does not exist on disk', () => {
	withCatalogFixture(
		'zz-lint-missing-template',
		`id: zz-lint-missing-template\ndescription: "fixture"\nstatic:\n  files:\n    - path: scripts/whatever.sh\n      template: bootstrap/does-not-exist-zz.sh\n      mode: "755"\nruntime:\n  script: scripts/whatever.sh\n  produces: []\n`,
		{},
		() => {
			const result = run(['catalog', 'lint', 'zz-lint-missing-template', '--json']);
			assert.equal(result.code, 1);
			const [entry] = JSON.parse(result.stdout);
			assert.equal(entry.ok, false);
			assert.match(entry.errors[0], /ENOENT/);
			assert.match(entry.errors[0], /does-not-exist-zz\.sh/);
		},
	);
});

test('catalog lint reports a template that references an undeclared {{VAR}} that will never be substituted', () => {
	withCatalogFixture(
		'zz-lint-residual-var',
		`id: zz-lint-residual-var\ndescription: "fixture"\nstatic:\n  files:\n    - path: scripts/whatever.sh\n      template: bootstrap/zz-lint-residual.txt\n      mode: "644"\nruntime:\n  script: scripts/whatever.sh\n  produces: []\n`,
		{ 'zz-lint-residual.txt': 'hello {{FOO}} on port {{PORT}}\n' },
		() => {
			const result = run(['catalog', 'lint', 'zz-lint-residual-var', '--json']);
			assert.equal(result.code, 1);
			const [entry] = JSON.parse(result.stdout);
			assert.equal(entry.ok, false);
			assert.match(entry.errors[0], /undeclared variable \{\{FOO\}\}/);
			// {{PORT}} IS substituted (planApply always passes {port: 8080}) so it must not be flagged.
			assert.ok(!entry.errors.some((e) => e.includes('{{PORT}}')), 'a real, always-substituted variable must not be flagged');
		},
	);
});

test('catalog lint --json on a mixed-outcome run reports one entry per choice, real choices unaffected by a broken fixture', () => {
	withCatalogFixture(
		'zz-lint-schema-bad',
		`id: zz-lint-schema-bad\ndescription: "fixture"\nstatic:\n  files: []\n`,
		{},
		() => {
			const result = run(['catalog', 'lint', '--json']);
			assert.equal(result.code, 1, 'overall exit must be non-zero when any choice fails');
			const results = JSON.parse(result.stdout);
			const ngrok = results.find((r) => r.choice === 'ngrok');
			const broken = results.find((r) => r.choice === 'zz-lint-schema-bad');
			assert.equal(ngrok.ok, true, 'a broken sibling catalog entry must not affect an unrelated one');
			assert.equal(broken.ok, false);
		},
	);
});
