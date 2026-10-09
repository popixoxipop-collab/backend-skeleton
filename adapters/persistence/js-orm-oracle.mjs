#!/usr/bin/env node
// Re-runs one ORM's offline oracle in a scratch install and compares (or freezes) the outputs.
//   node adapters/persistence/js-orm-oracle.mjs <orm> [--check | --write] [--only <stepId>] [--keep]
//   node adapters/persistence/js-orm-oracle.mjs <orm> --pins [--write]
// The install happens in a fresh temporary directory (os.tmpdir(), honours TMPDIR); nothing is
// installed into the repository. Steps never open a database connection.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORMS = ['prisma', 'drizzle', 'typeorm', 'sequelize'];

function usage(message) {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write('usage: js-orm-oracle.mjs <prisma|drizzle|typeorm|sequelize> [--check|--write] [--only <stepId>] [--keep] | --pins [--write]\n');
	process.exit(2);
}

const args = process.argv.slice(2);
const orm = args.shift();
if (!ORMS.includes(orm)) usage(`unknown orm: ${orm}`);
const flags = { mode: 'check', only: null, keep: false, pins: false };
while (args.length) {
	const a = args.shift();
	if (a === '--check') flags.mode = 'check';
	else if (a === '--write') flags.mode = 'write';
	else if (a === '--keep') flags.keep = true;
	else if (a === '--pins') flags.pins = true;
	else if (a === '--only') flags.only = args.shift() ?? '';
	else usage(`unknown argument: ${a}`);
}

const ormDir = path.join(HERE, orm);
const scopePath = path.join(ormDir, 'SCOPE.json');
const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
const selected = scope.oracle.steps.filter((step) => flags.only === null || step.id === flags.only);
if (flags.pins && flags.only !== null) usage('--only cannot be combined with --pins');
if (!flags.pins && selected.length === 0) usage(flags.only === null ? 'the record lists no oracle steps' : `unknown step id ${JSON.stringify(flags.only)}; valid ids: ${scope.oracle.steps.map((step) => step.id).join(', ') || '(none)'}`);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const lf = (text) => text.replace(/\r\n/g, '\n');
const log = (message) => process.stderr.write(`${message}\n`);

function saveScope() {
	fs.writeFileSync(scopePath, `${JSON.stringify(scope, null, '\t')}\n`);
}

const stepEnvKeys = new Set(scope.oracle.steps.flatMap((step) => [step, ...(step.pre ?? [])].flatMap((item) => Object.keys(item.env ?? {}))));
const inheritedEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !stepEnvKeys.has(key)));

function exec(argv, { cwd, env = {}, timeout = 180000 }) {
	const [head, ...rest] = argv;
	const file = head === 'node' ? process.execPath : head.startsWith('node_modules/') ? path.join(cwd, head) : head;
	const result = spawnSync(file, rest, {
		cwd,
		encoding: 'utf8',
		timeout,
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024,
		env: { ...inheritedEnv(), CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NO_COLOR: '1', ...env },
	});
	return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function npmView(spec) {
	const r = exec(['npm', 'view', spec, 'version'], { cwd: os.tmpdir(), timeout: 60000 });
	return { command: `npm view ${spec} version`, exit_code: r.status, output: lf(r.stdout).trim() };
}

function verifyPins() {
	const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
	let failed = false;
	for (const pkg of scope.pins.packages) {
		const view = npmView(`${pkg.name}@${pkg.version}`);
		const ok = view.exit_code === 0 && view.output === pkg.version;
		if (!ok) failed = true;
		log(`${pkg.name}@${pkg.version}: exit=${view.exit_code} output=${JSON.stringify(view.output)} ${ok ? 'OK' : 'MISMATCH'}`);
		if (flags.mode === 'write') pkg.registry_check = { ...view, output_sha256: sha256(view.output) };
	}
	for (const item of scope.pins.not_covered ?? []) {
		if (!item.dist_tag) continue;
		const view = npmView(`${item.name}@${item.dist_tag}`);
		const ok = view.exit_code === 0 && view.output === item.version;
		if (!ok) failed = true;
		log(`${item.name}@${item.dist_tag}: exit=${view.exit_code} output=${JSON.stringify(view.output)} ${ok ? 'OK' : `MISMATCH (not_covered records ${item.version})`}`);
		if (flags.mode === 'write') item.registry_check = { ...view, output_sha256: sha256(view.output) };
	}
	if (flags.mode === 'write' && failed) log('registry checks failed: SCOPE.json not written');
	else if (flags.mode === 'write') {
		scope.pins.checked_at = stamp;
		saveScope();
	}
	process.exit(failed ? 1 : 0);
}

if (flags.pins) verifyPins();

const runtime = { node: process.version, npm: exec(['npm', '--version'], { cwd: os.tmpdir() }).stdout.trim(), platform: process.platform, arch: process.arch };
const runtimeOf = (item) => JSON.stringify([item.node, item.npm, item.platform, item.arch]);
// Unselected steps keep results recorded under oracle.environment, so a partial --write must run under that runtime and never rewrites it.
if (flags.mode === 'write' && flags.only !== null && runtimeOf(scope.oracle.environment ?? {}) !== runtimeOf(runtime)) {
	log(`FAIL: --write --only would mix runtimes: recorded ${runtimeOf(scope.oracle.environment ?? {})}, this run ${runtimeOf(runtime)}; re-run --write without --only`);
	process.exit(1);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `orm-oracle-${orm}-`));
log(`workdir: ${workdir}`);
const cleanup = () => {
	if (!flags.keep) fs.rmSync(workdir, { recursive: true, force: true });
};

function fail(message) {
	log(`FAIL: ${message}`);
	cleanup();
	process.exit(1);
}

const install = scope.pins.packages.filter((pkg) => pkg.oracle_install);
const manifest = {
	name: `orm-oracle-${orm}`,
	private: true,
	version: '0.0.0',
	type: scope.oracle.module_type === 'module' ? 'module' : undefined,
	dependencies: Object.fromEntries(install.map((pkg) => [pkg.name, pkg.version])),
};
fs.writeFileSync(path.join(workdir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const npmResult = exec(['npm', 'install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: workdir, timeout: 600000 });
if (npmResult.status !== 0) fail(`npm install exit ${npmResult.status}\n${npmResult.stderr.slice(0, 2000)}`);

const installed = {};
for (const pkg of install) {
	const manifestPath = path.join(workdir, 'node_modules', pkg.name, 'package.json');
	installed[pkg.name] = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
	if (installed[pkg.name] !== pkg.version) fail(`installed ${pkg.name}@${installed[pkg.name]} != pin ${pkg.version}`);
}

function copyTree(from, to, skip = () => false) {
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (skip(src)) continue;
		if (entry.isDirectory()) {
			fs.mkdirSync(dst, { recursive: true });
			copyTree(src, dst, skip);
		} else fs.copyFileSync(src, dst);
	}
}
copyTree(path.join(ormDir, 'fixtures'), path.join(workdir, 'fixtures'));
fs.mkdirSync(path.join(workdir, 'oracle'), { recursive: true });
copyTree(path.join(ormDir, 'oracle'), path.join(workdir, 'oracle'), (src) => src === path.join(ormDir, 'oracle', 'results'));

function capture(part, step, stdout, stderr) {
	if (part.kind === 'stdout') return stdout;
	if (part.kind === 'stderr') return part.first_line ? `${stderr.split('\n')[0]}\n` : stderr;
	if (part.kind === 'file') {
		const file = path.join(workdir, part.path);
		if (!fs.existsSync(file)) throw new Error(`step ${step.id}: expected output file ${part.path} was not produced`);
		return fs.readFileSync(file, 'utf8');
	}
	if (part.kind === 'listing') {
		const dir = path.join(workdir, part.path);
		if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`step ${step.id}: expected output directory ${part.path} was not produced`);
		return `${fs.readdirSync(dir).sort().join('\n')}\n`;
	}
	throw new Error(`step ${step.id}: unknown capture kind ${part.kind}`);
}

function runStep(step) {
	for (const rel of step.clean ?? []) fs.rmSync(path.join(workdir, rel), { recursive: true, force: true });
	for (const pre of step.pre ?? []) {
		const r = exec(pre.argv, { cwd: workdir, env: pre.env });
		if (r.status !== (pre.expect_exit ?? 0)) throw new Error(`step ${step.id}: pre command exit ${r.status}: ${pre.argv.join(' ')}\n${r.stderr.slice(0, 1000)}`);
	}
	const r = exec(step.argv, { cwd: workdir, env: step.env });
	if (r.error) throw new Error(`step ${step.id}: ${r.error.message}`);
	const stdout = lf(r.stdout);
	const stderr = lf(r.stderr);
	const parts = step.capture.map((part) => lf(capture(part, step, stdout, stderr)));
	const content = parts.length === 1
		? parts[0]
		: step.capture.map((part, i) => `### ${part.kind}${part.path ? ` ${part.path}` : ''}\n${parts[i].endsWith('\n') ? parts[i] : `${parts[i]}\n`}`).join('');
	return { exit_code: r.status, content };
}

const report = {
	orm,
	mode: flags.mode,
	...runtime,
	installed,
	steps: [],
};
let failed = false;
const staged = [];
for (const step of selected) {
	let first;
	let second;
	try {
		first = runStep(step);
		second = runStep(step);
	} catch (error) {
		log(`step ${step.id}: ${error.message}`);
		failed = true;
		continue;
	}
	const deterministic = first.content === second.content && first.exit_code === second.exit_code;
	const entry = {
		id: step.id,
		exit_code: first.exit_code,
		expect_exit: step.expect_exit,
		deterministic,
		output_sha256: sha256(first.content),
		output_bytes: Buffer.byteLength(first.content),
	};
	if (first.exit_code !== step.expect_exit || !deterministic) failed = true;
	const resultPath = path.join(ormDir, step.result_file);
	if (flags.mode === 'write') {
		staged.push({ step, resultPath, content: first.content, update: { exit_code: first.exit_code, output_sha256: entry.output_sha256, output_bytes: entry.output_bytes, runs: 2, deterministic: true } });
	} else {
		const frozen = fs.existsSync(resultPath) ? lf(fs.readFileSync(resultPath, 'utf8')) : null;
		entry.frozen_match = frozen === first.content && step.output_sha256 === entry.output_sha256 && step.exit_code === first.exit_code;
		if (!entry.frozen_match) failed = true;
	}
	report.steps.push(entry);
}

// Result files and SCOPE.json are written only once every selected step has passed.
if (flags.mode === 'write' && failed) log('a selected step failed: no result file and no SCOPE.json were written');
if (flags.mode === 'write' && !failed) {
	for (const { step, resultPath, content, update } of staged) {
		fs.mkdirSync(path.dirname(resultPath), { recursive: true });
		fs.writeFileSync(resultPath, content);
		Object.assign(step, update);
	}
	if (flags.only === null) scope.oracle.environment = { ...runtime, installed, recorded_by: `adapters/persistence/js-orm-oracle.mjs ${orm} --write` };
	saveScope();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
cleanup();
process.exit(failed ? 1 : 0);
