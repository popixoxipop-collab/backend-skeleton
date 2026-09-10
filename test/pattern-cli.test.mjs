// D-pattern-accrual: CLI-level tests that don't need a real Postgres -- the usage-mistake paths
// (checked BEFORE any network/filesystem write, per new/index.mjs's own comment on
// requireStackParams) and the best-effort-never-fails-the-scaffold path (an unreachable host is
// enough to prove "warns, never fails" -- it doesn't need a real table on the other end). The real
// record/list/show/suggest round trip against a live table is scripts/pattern-db-smoke.mjs, wired
// into the existing db-introspect CI job (see DECISIONS.md's D-pattern-accrual).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

// Loopback, port 1 -- nothing ever listens there, so the OS refuses the connection (ECONNREFUSED)
// near-instantly. Deliberately NOT a routable-but-dead external address (e.g. an RFC 5737
// TEST-NET-1 IP): those can sit unanswered until a TCP timeout instead of failing fast, which
// would make this suite flaky/slow depending on the sandbox's outbound network policy.
const UNREACHABLE_URL = 'postgres://postgres@127.0.0.1:1/nope';

// spawnSync, not execFileSync -- execFileSync only ever returns stdout on its SUCCESS path
// (stderr is only captured when it throws, i.e. a non-zero exit). The best-effort warning this
// suite needs to assert on is printed on a SUCCESS path (exit 0) by design, so execFileSync would
// silently report an empty stderr no matter what the CLI actually printed -- found live, the same
// pitfall test/observe-import-cli.test.mjs already hit for its own WARNING-message assertions.
function run(args, cwd, env = {}) {
	const result = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15000 });
	return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function freshDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-pattern-cli-'));
}

// ---- bskel new --record-pattern: usage mistakes, checked before any write --------------------

test('bskel new --record-pattern without --pattern-database-url-env is BAD_ARGS (14), and nothing is scaffolded', () => {
	const parent = freshDir();
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir, '--record-pattern'], parent);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /--record-pattern requires --pattern-database-url-env/);
	assert.equal(fs.existsSync(dir), false);
});

test('bskel new --record-pattern --pattern-database-url-env <NAME> where NAME is not exported is BAD_ARGS (14), and nothing is scaffolded', () => {
	const parent = freshDir();
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir, '--record-pattern', '--pattern-database-url-env', 'BSKEL_PATTERN_TEST_UNSET_VAR'], parent);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /BSKEL_PATTERN_TEST_UNSET_VAR names an environment variable that isn't set/);
	assert.equal(fs.existsSync(dir), false);
});

// ---- best-effort: an unreachable pattern store never fails the scaffold ----------------------

test('bskel new --record-pattern against an unreachable database still scaffolds and exits 0, warning on stderr only', () => {
	const parent = freshDir();
	const dir = path.join(parent, 'demo-app');
	const result = run(
		['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir, '--record-pattern', '--pattern-database-url-env', 'BSKEL_PATTERN_TEST_URL'],
		parent,
		{ BSKEL_PATTERN_TEST_URL: UNREACHABLE_URL },
	);
	assert.equal(result.code, 0);
	assert.ok(fs.existsSync(path.join(dir, 'pyproject.toml')), 'the project must be fully scaffolded even though recording failed');
	assert.match(result.stderr, /warning: --record-pattern could not write to the pattern store/);
});

// ---- no regression: neither new flag present -> unchanged behavior ---------------------------

test('bskel new without --record-pattern/--pattern-database-url-env scaffolds exactly as before (no DB connection ever attempted)', () => {
	const parent = freshDir();
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir], parent);
	assert.equal(result.code, 0);
	assert.ok(fs.existsSync(path.join(dir, 'pyproject.toml')));
	assert.doesNotMatch(result.stdout, /pattern store/);
});

// ---- bskel pattern list/show/suggest: usage mistakes and connection failures -------------------

test('bskel pattern list without --pattern-database-url-env is BAD_ARGS (14)', () => {
	const result = run(['pattern', 'list'], freshDir());
	assert.equal(result.code, 14);
});

test('bskel pattern list --pattern-database-url-env <NAME> where NAME is not exported is BAD_ARGS (14)', () => {
	const result = run(['pattern', 'list', '--pattern-database-url-env', 'BSKEL_PATTERN_TEST_UNSET_VAR'], freshDir());
	assert.equal(result.code, 14);
	assert.match(result.stderr, /BSKEL_PATTERN_TEST_UNSET_VAR names an environment variable that isn't set/);
});

test('bskel pattern list --stack <bogus> is BAD_ARGS (14), checked before any connection attempt', () => {
	const result = run(
		['pattern', 'list', '--stack', 'django', '--pattern-database-url-env', 'BSKEL_PATTERN_TEST_URL'],
		freshDir(),
		{ BSKEL_PATTERN_TEST_URL: UNREACHABLE_URL },
	);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /--stack must be one of: spring, fastapi/);
});

test('bskel pattern list against an unreachable database is REFRESH_FAILED (18), not a raw stack trace', () => {
	const result = run(
		['pattern', 'list', '--pattern-database-url-env', 'BSKEL_PATTERN_TEST_URL'],
		freshDir(),
		{ BSKEL_PATTERN_TEST_URL: UNREACHABLE_URL },
	);
	assert.equal(result.code, 18);
	assert.doesNotMatch(result.stderr, /at Object\.<anonymous>/); // no raw Node stack trace leaked
});

test('bskel pattern show with no pattern_id positional is BAD_ARGS (14)', () => {
	const result = run(
		['pattern', 'show', '--pattern-database-url-env', 'BSKEL_PATTERN_TEST_URL'],
		freshDir(),
		{ BSKEL_PATTERN_TEST_URL: UNREACHABLE_URL },
	);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /usage: bskel pattern show <pattern_id>/);
});

test('bskel pattern suggest --stack <bogus> is BAD_ARGS (14)', () => {
	const result = run(
		['pattern', 'suggest', '--stack', 'django', '--pattern-database-url-env', 'BSKEL_PATTERN_TEST_URL'],
		freshDir(),
		{ BSKEL_PATTERN_TEST_URL: UNREACHABLE_URL },
	);
	assert.equal(result.code, 14);
});

test('bskel pattern suggest against an unreachable database is REFRESH_FAILED (18)', () => {
	const result = run(
		['pattern', 'suggest', '--stack', 'fastapi', '--pattern-database-url-env', 'BSKEL_PATTERN_TEST_URL'],
		freshDir(),
		{ BSKEL_PATTERN_TEST_URL: UNREACHABLE_URL },
	);
	assert.equal(result.code, 18);
});

// ---- --help documents the new flags/commands ---------------------------------------------------

test('bskel new --help documents --record-pattern and --pattern-database-url-env', () => {
	const help = run(['new', '--help'], os.tmpdir());
	assert.match(help.stdout, /--record-pattern/);
	assert.match(help.stdout, /--pattern-database-url-env/);
});

test('bskel pattern suggest --help renders without crashing', () => {
	const help = run(['pattern', 'suggest', '--help'], os.tmpdir());
	assert.equal(help.code, 0);
	assert.match(help.stdout, /usage: bskel pattern suggest/);
});
