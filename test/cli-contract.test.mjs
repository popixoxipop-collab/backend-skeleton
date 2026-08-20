// D-cli-contract (D2): unit tests for lib/cli.mjs (strict node:util.parseArgs-based parsing,
// numeric validation, exit-code table) plus e2e tests for the observable CLI contract (global
// flags, --json diagnostic envelope, crash fixes). See DECISIONS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMANDS, parseCommand, CliUsageError, diagnostic } from '../lib/cli.mjs';
import { EXIT_CODES } from '../lib/exit-codes.mjs';
import { EXIT } from '../lib/gates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// ---- unit: parseCommand() -------------------------------------------------

test('unknown flag is rejected, not silently absorbed as a positional', () => {
	assert.throws(() => parseCommand('verify', ['--bogus']), CliUsageError);
});

test('a value-taking flag with no value at the end of argv is rejected, not left undefined', () => {
	assert.throws(() => parseCommand('verify', ['--feature']), CliUsageError);
});

test('--feature --json (D2\'s headline crash bug) is rejected as ambiguous, not silently swallowing --json as the value', () => {
	assert.throws(() => parseCommand('verify', ['--feature', '--json']), CliUsageError);
});

test('--feature=--json is accepted -- an explicit inline value is never ambiguous', () => {
	const flags = parseCommand('verify', ['--feature=--json']);
	assert.equal(flags.feature, '--json');
});

test('duplicate flags: last one wins', () => {
	const flags = parseCommand('verify', ['--feature', 'a', '--feature', 'b']);
	assert.equal(flags.feature, 'b');
});

test('positionals are rejected for commands that do not declare allowPositionals', () => {
	assert.throws(() => parseCommand('status', ['001-widget']), CliUsageError);
});

test('positionals are accepted for gate commands (the gate name)', () => {
	const flags = parseCommand('gate require', ['contract', '--feature', '001-x']);
	assert.deepEqual(flags._, ['contract']);
	assert.equal(flags.feature, '001-x');
});

test('numeric validation: --max-behind rejects non-numeric, negative, and fractional values', () => {
	for (const bad of ['abc', '-1', '1.5', '']) {
		assert.throws(() => parseCommand('preflight', ['--max-behind', bad]), CliUsageError, `expected --max-behind ${JSON.stringify(bad)} to be rejected`);
	}
	const ok = parseCommand('preflight', ['--max-behind', '5']);
	assert.equal(ok['max-behind'], '5');
});

test('numeric validation: --port enforces its 1..65535 range', () => {
	for (const bad of ['abc', '0', '70000']) {
		assert.throws(() => parseCommand('stack apply', ['--port', bad]), CliUsageError);
	}
	const ok = parseCommand('stack apply', ['--port', '9090']);
	assert.equal(ok.port, '9090');
});

// D-preflight-freshness (S3)
test('numeric validation: --max-age-minutes rejects non-numeric, negative, and fractional values', () => {
	for (const bad of ['abc', '-1', '1.5', '']) {
		assert.throws(() => parseCommand('preflight', ['--max-age-minutes', bad]), CliUsageError, `expected --max-age-minutes ${JSON.stringify(bad)} to be rejected`);
	}
	assert.equal(parseCommand('preflight', ['--max-age-minutes', '0'])['max-age-minutes'], '0');
	assert.equal(parseCommand('preflight', ['--max-age-minutes', '45'])['max-age-minutes'], '45');
});

test('numeric validation: --fetch-timeout-seconds rejects non-numeric, negative, and fractional values', () => {
	for (const bad of ['abc', '-1', '1.5', '']) {
		assert.throws(() => parseCommand('preflight', ['--fetch-timeout-seconds', bad]), CliUsageError, `expected --fetch-timeout-seconds ${JSON.stringify(bad)} to be rejected`);
	}
	assert.equal(parseCommand('preflight', ['--fetch-timeout-seconds', '120'])['fetch-timeout-seconds'], '120');
});

test('required field missing produces the command\'s own usage line', () => {
	try {
		parseCommand('verify', []);
		assert.fail('expected a throw');
	} catch (err) {
		assert.ok(err instanceof CliUsageError);
		assert.match(err.message, /usage: bskel verify --feature/);
	}
});

test('--help short-circuits before required-field validation', () => {
	const flags = parseCommand('handles emit', ['--help']);
	assert.equal(flags.help, true);
});

// Default-value snapshot: every COMMANDS entry parsed with zero argv must reproduce exactly the
// old parseFlags() defaults -- this is the machine-checked proof that the migration off
// parseFlags lost nothing. Commands with a `required` field throw on empty argv (expected, listed
// separately) rather than returning defaults.
const EXPECTED_DEFAULTS = {
	preflight: { _: [], 'max-behind': '0', offline: false, 'no-fetch': false, 'allow-dirty': false, 'max-age-minutes': '30', 'fetch-timeout-seconds': '60', json: false, quiet: false, help: false },
	'gate require': { _: [], feature: '_repo', json: false, quiet: false, help: false },
	'gate force': { _: [], feature: '_repo', reason: '', 'max-age-minutes': null, json: false, quiet: false, help: false },
	'gate revoke': { _: [], feature: '_repo', reason: '', json: false, quiet: false, help: false },
	'gate history': { _: [], feature: '_repo', json: false, quiet: false, help: false },
	'gate show': { _: [], feature: '_repo', json: false, quiet: false, help: false },
	scan: { _: [], feature: null, terms: '', db: false, json: false, 'accept-low-confidence': false, quiet: false, help: false },
	'stack apply': { _: [], choice: null, apply: false, port: '8080', json: false, quiet: false, help: false },
	'catalog lint': { _: [], json: false, quiet: false, help: false },
	status: { _: [], feature: null, json: false, quiet: false, help: false },
	next: { _: [], feature: null, json: false, quiet: false, help: false },
	doctor: { _: [], workflow: null, json: false, quiet: false, help: false },
};

for (const [name, expected] of Object.entries(EXPECTED_DEFAULTS)) {
	test(`parseCommand("${name}", []) default-value snapshot matches the pre-D2 parseFlags defaults exactly`, () => {
		assert.deepEqual(parseCommand(name, []), expected);
	});
}

// Commands with `required` fields: empty argv must throw (this itself proves the migration was
// lossless for the "missing required flag" behavior class too).
for (const name of ['scan disposition', 'scan explain', 'feature init', 'contract emit', 'contract waive', 'contract validate', 'contract tool-schema', 'handles plan', 'handles emit', 'verify']) {
	test(`parseCommand("${name}", []) throws CliUsageError (required field missing)`, () => {
		assert.throws(() => parseCommand(name, []), CliUsageError);
	});
}

test('every command in COMMANDS is exercised by the default-value snapshot or the required-field test above', () => {
	const covered = new Set([...Object.keys(EXPECTED_DEFAULTS), 'scan disposition', 'scan explain', 'feature init', 'contract emit', 'contract waive', 'contract validate', 'contract tool-schema', 'handles plan', 'handles emit', 'verify']);
	assert.deepEqual([...covered].sort(), Object.keys(COMMANDS).sort());
});

// ---- unit: exit-code table -------------------------------------------------

test('every EXIT_CODES value is unique', () => {
	const values = Object.values(EXIT_CODES);
	assert.equal(new Set(values).size, values.length);
});

test('lib/gates.mjs\'s EXIT is byte-identical to the corresponding entries in EXIT_CODES', () => {
	assert.equal(EXIT.PASS, EXIT_CODES.OK);
	assert.equal(EXIT.NOT_PASSED, EXIT_CODES.NOT_PASSED);
	assert.equal(EXIT.AWAITING_DISPOSITION, EXIT_CODES.AWAITING_DISPOSITION);
	assert.equal(EXIT.STALE, EXIT_CODES.STALE);
});

test('diagnostic() shape matches the sbf.cli-diagnostic/1 contract', () => {
	const d = diagnostic({ command: 'status', code: 14, reason: 'BAD_ARGS', message: 'boom', next_actions: [] });
	assert.equal(d.schema, 'sbf.cli-diagnostic/1');
	assert.equal(d.ok, false);
	assert.equal(d.command, 'status');
	assert.equal(d.code, 14);
	assert.equal(d.reason, 'BAD_ARGS');
	assert.deepEqual(d.diagnostics, [{ level: 'error', reason: 'BAD_ARGS', message: 'boom' }]);
});

// ---- static regression guard: every process.exit()/process.exitCode literal in bin/bskel.mjs is
// a value from EXIT_CODES, and parseFlags( is fully gone. ----

test('bin/bskel.mjs: every process.exit(<literal>)/process.exitCode = <literal> uses a value from the exit-code table', () => {
	const source = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'bskel.mjs'), 'utf8');
	const known = new Set(Object.values(EXIT_CODES));
	const found = [...source.matchAll(/process\.exit(?:Code)?\s*[=(]\s*(\d+)\b/g)].map((m) => Number(m[1]));
	assert.ok(found.length > 0, 'expected at least one literal exit code in bin/bskel.mjs');
	const unknown = found.filter((code) => !known.has(code));
	assert.deepEqual(unknown, [], `found exit code literal(s) not in EXIT_CODES: ${unknown.join(', ')}`);
});

test('bin/bskel.mjs no longer defines its own parseFlags()', () => {
	const source = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'bskel.mjs'), 'utf8');
	assert.ok(!source.includes('function parseFlags('), 'parseFlags() should have been fully replaced by lib/cli.mjs\'s parseCommand()');
});

// ---- e2e: global flags -------------------------------------------------

test('e2e: bskel --help exits 0, prints usage on stdout, nothing on stderr', () => {
	const r = run(['--help'], REPO_ROOT);
	assert.equal(r.code, 0);
	assert.match(r.stdout, /backend-skeleton CLI/);
	assert.equal(r.stderr, '');
});

test('e2e: bskel help (no dashes) behaves the same as --help', () => {
	const r = run(['help'], REPO_ROOT);
	assert.equal(r.code, 0);
	assert.match(r.stdout, /backend-skeleton CLI/);
});

test('e2e: bare `bskel` (no args) exits 0 with usage on stdout', () => {
	const r = run([], REPO_ROOT);
	assert.equal(r.code, 0);
	assert.match(r.stdout, /backend-skeleton CLI/);
	assert.equal(r.stderr, '');
});

test('e2e: an unknown top-level command still exits 14 on stderr (unchanged)', () => {
	const r = run(['bogus-command'], REPO_ROOT);
	assert.equal(r.code, 14);
	assert.match(r.stderr, /backend-skeleton CLI/);
});

test('e2e: `<cmd> --help` renders that command\'s own usage and exits 0', () => {
	const r = run(['handles', 'emit', '--help'], REPO_ROOT);
	assert.equal(r.code, 0);
	assert.match(r.stdout, /usage: bskel handles emit/);
});

test('e2e: --version reports the version from package.json', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
	const r = run(['--version'], REPO_ROOT);
	assert.equal(r.code, 0);
	assert.equal(r.stdout.trim(), `bskel ${pkg.version}`);
});

test('e2e: --version --json is parseable and matches package.json', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
	const r = run(['--version', '--json'], REPO_ROOT);
	assert.equal(r.code, 0);
	assert.deepEqual(JSON.parse(r.stdout), { name: 'bskel', version: pkg.version });
});

// ---- e2e: crash fixes -------------------------------------------------

function buildBareRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-cli-contract-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-cli-contract-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('e2e: `verify --feature --json` no longer crashes with an uncaught stack trace', () => {
	const root = buildBareRepo();
	const r = run(['verify', '--feature', '--json'], root);
	assert.equal(r.code, 14);
	assert.ok(!/\n\s+at /.test(r.stderr), `expected no stack frame in stderr, got:\n${r.stderr}`);
});

test('e2e: `status --feature bogus` no longer crashes with an uncaught stack trace', () => {
	const root = buildBareRepo();
	const r = run(['status', '--feature', 'bogus'], root);
	assert.equal(r.code, 14);
	assert.ok(!/\n\s+at /.test(r.stderr), `expected no stack frame in stderr, got:\n${r.stderr}`);
});

test('e2e: `status 001-widget` (stray positional, a common --feature typo) is rejected, not silently ignored as a success', () => {
	const root = buildBareRepo();
	run(['preflight'], root);
	const r = run(['status', '001-widget'], root);
	assert.equal(r.code, 14);
});

// ---- e2e: --json error consistency (the additive diagnostic envelope) -------------------------

test('e2e: `status --bogus --json` prints a parseable sbf.cli-diagnostic/1 envelope to stdout, human message still on stderr', () => {
	const root = buildBareRepo();
	const r = run(['status', '--bogus', '--json'], root);
	assert.equal(r.code, 14);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.schema, 'sbf.cli-diagnostic/1');
	assert.equal(doc.ok, false);
	assert.equal(doc.code, 14);
	assert.ok(r.stderr.length > 0, 'the human-readable stderr message must still be present (additive, not replaced)');
});

test('e2e: `scan --feature <id> --json` before preflight has run reports GATE_NOT_PASSED with a next_actions pointer to preflight', () => {
	const root = buildBareRepo();
	// `scan` doesn't need `feature init` to have run first (it just labels artifacts under
	// specs/<id>/) -- and `feature init` itself requires preflight, which is exactly the gate
	// this test wants to still be un-run, so it must be skipped here.
	const r = run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--json'], root);
	assert.notEqual(r.code, 0);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.schema, 'sbf.cli-diagnostic/1');
	assert.equal(doc.reason, 'GATE_NOT_PASSED');
	assert.ok(doc.next_actions.some((a) => a.command.includes('preflight')), `expected a preflight next_action, got: ${JSON.stringify(doc.next_actions)}`);
	assert.match(r.stderr, /preflight/);
});

test('e2e: `contract emit --json` before the scan gate has passed reports GATE_NOT_PASSED', () => {
	const root = buildBareRepo();
	run(['preflight'], root);
	execFileSync('node', [CLI, 'feature', 'init', '--slug', 'widget-management'], { cwd: root });
	const r = run(['contract', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.notEqual(r.code, 0);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.schema, 'sbf.cli-diagnostic/1');
	assert.equal(doc.reason, 'GATE_NOT_PASSED');
	assert.match(r.stderr, /scan/);
});

test('e2e: `doctor --workflow bogus --json` now emits JSON instead of a plain-text error', () => {
	const root = buildBareRepo();
	const r = run(['doctor', '--workflow', 'bogus', '--json'], root);
	assert.equal(r.code, 14);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.schema, 'sbf.cli-diagnostic/1');
	assert.equal(doc.code, 14);
	assert.match(r.stderr, /unknown workflow/);
});

test('e2e: a payload-bearing non-zero exit is NOT wrapped in a diagnostic envelope (one execution, one JSON document)', () => {
	const root = buildBareRepo();
	run(['preflight'], root);
	execFileSync('node', [CLI, 'feature', 'init', '--slug', 'widget-management'], { cwd: root });
	// A bare fixture repo has no java-spring/python-fastapi signal, so the scan falls back to the
	// low-confidence generic-grep adapter -- --accept-low-confidence is required to still pass.
	const scan = run(['scan', '--feature', '001-widget-management', '--terms', 'zzzz-nomatch-zzzz', '--accept-low-confidence', '--json'], root);
	assert.equal(scan.code, 0, scan.stderr); // greenfield -> passes
	const verify = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.notEqual(verify.code, 0); // contract gate not run -> overall fail, but this IS the real payload
	const doc = JSON.parse(verify.stdout);
	assert.equal(doc.schema, undefined, 'verify --json must still return its own real report shape, not a diagnostic wrapper');
	assert.ok(Object.hasOwn(doc, 'pass'), 'verify --json payload shape must be unchanged');
});

// ---- e2e: --json compatibility for already-JSON-only commands -------------------------

test('e2e: `gate show --json` no longer misfires as "unknown gate --json"', () => {
	const root = buildBareRepo();
	run(['preflight'], root);
	const r = run(['gate', 'show', '--json'], root);
	assert.equal(r.code, 0, r.stderr);
	assert.doesNotThrow(() => JSON.parse(r.stdout));
});

// ---- e2e: --quiet -------------------------------------------------

test('e2e: --quiet suppresses narration stdout but keeps the same exit code', () => {
	const root = buildBareRepo();
	const normal = run(['preflight'], root);
	const quiet = run(['preflight', '--quiet'], root);
	assert.equal(quiet.code, normal.code);
	assert.equal(quiet.stdout, '');
});

test('e2e: --quiet --json still prints the JSON payload', () => {
	const root = buildBareRepo();
	const r = run(['preflight', '--quiet', '--json'], root);
	assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('e2e: --quiet does not suppress a blocking error message on stderr', () => {
	const root = buildBareRepo();
	const r = run(['scan', '--quiet'], root); // no terms -> usage error
	assert.equal(r.code, 14);
	assert.ok(r.stderr.length > 0);
});

// ---- e2e: the numeric-flag fix, through the real bskel CLI (not just the standalone script --
// see test/preflight.test.mjs for the script-level regression). ----

test('e2e: `bskel preflight --max-behind abc` is rejected at exit 14 and never writes the preflight gate', () => {
	const root = buildBareRepo();
	const r = run(['preflight', '--max-behind', 'abc'], root);
	assert.equal(r.code, 14);
	const gate = run(['gate', 'require', 'preflight'], root);
	assert.notEqual(gate.code, 0, 'the preflight gate must not have been recorded as passing');
});
