#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { repoRoot, headSha, localDefaultBranch } from '../lib/repo.mjs';
import { requireGate, forceGate, passGate, EXIT } from '../lib/gates.mjs';
import { getGate, loadState } from '../lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

// The preflight gate is repo-scoped, not feature-scoped -- it runs before a feature_id exists.
// Stored under the same per-feature state-file mechanism using the reserved id "_repo".
const REPO_GATE_ID = '_repo';

// Each gate's token must be computed from the SAME function both when the gate is written
// (pass) and when it's re-verified (require) -- otherwise "require" degenerates into comparing
// stored data against itself, which can never detect drift. One shared recomputer per gate name
// closes that gap structurally instead of relying on call sites staying in sync by hand.
// Gates without an entry here (scan/contract -- added in later phases) fall back to comparing
// against their own stored evidence, which means they cannot yet detect staleness on their own;
// each phase that adds a new gate-emitting command must register its recomputer here too.
const GATE_RECOMPUTERS = {
	preflight: (root) => ({ head_sha: headSha(root), default_branch: localDefaultBranch(root) }),
};

function currentGateInputs(root, gateName, storedEvidence) {
	const recompute = GATE_RECOMPUTERS[gateName];
	return recompute ? recompute(root) : (storedEvidence ?? {});
}

function usage() {
	console.error(`bskel -- backend-skeleton CLI

  bskel preflight [--max-behind N] [--no-fetch] [--allow-dirty] [--json]
  bskel gate require <name> [--feature <id>]
  bskel gate force <name> --reason "..." [--feature <id>]
  bskel gate show [--feature <id>]
  bskel doctor
`);
}

function requireRepoRoot() {
	const root = repoRoot();
	if (!root) {
		console.error('bskel: not inside a git repository');
		process.exit(10);
	}
	return root;
}

function parseFlags(args, spec) {
	const out = { _: [] };
	for (const key of Object.keys(spec)) out[key] = spec[key].default;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const flagName = arg.startsWith('--') ? arg.slice(2) : null;
		if (flagName && flagName in spec) {
			if (spec[flagName].type === 'boolean') {
				out[flagName] = true;
			} else {
				out[flagName] = args[++i];
			}
		} else {
			out._.push(arg);
		}
	}
	return out;
}

function cmdPreflight(args) {
	const flags = parseFlags(args, {
		'max-behind': { type: 'string', default: '0' },
		'no-fetch': { type: 'boolean', default: false },
		'allow-dirty': { type: 'boolean', default: false },
		json: { type: 'boolean', default: false },
	});
	const root = requireRepoRoot();
	const scriptPath = path.join(SKILL_ROOT, 'scripts', 'preflight-base-ref.sh');
	const scriptArgs = ['--max-behind', flags['max-behind']];
	if (flags['no-fetch']) scriptArgs.push('--no-fetch');
	if (flags['allow-dirty']) scriptArgs.push('--allow-dirty');
	scriptArgs.push('--json');

	let stdout;
	let exitCode = 0;
	try {
		stdout = execFileSync(scriptPath, scriptArgs, { cwd: root, encoding: 'utf8' });
	} catch (err) {
		stdout = err.stdout ?? '';
		exitCode = err.status ?? 1;
	}
	const result = JSON.parse(stdout);

	if (result.verdict === 'PASS') {
		passGate(root, REPO_GATE_ID, 'preflight', GATE_RECOMPUTERS.preflight(root), result.evidence);
	}

	if (flags.json) {
		console.log(stdout.trim());
	} else if (result.verdict === 'PASS') {
		console.log(`PASS: HEAD is up to date with origin/${result.evidence.default_branch}`);
	} else {
		console.error(`FAIL (${result.reason}): ${result.message}`);
	}
	process.exit(exitCode);
}

function cmdGateRequire(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, { feature: { type: 'string', default: REPO_GATE_ID } });
	const gateName = flags._[0];
	if (!gateName) { console.error('usage: bskel gate require <name> [--feature <id>]'); process.exit(14); }
	const record = getGate(root, flags.feature, gateName);
	// `require` never re-runs the underlying check (e.g. it doesn't re-fetch or re-scan) --
	// it freshly recomputes only the cheap, local inputs the gate's token was built from
	// (see GATE_RECOMPUTERS) and compares against what was stored when the gate last passed.
	const currentInputs = currentGateInputs(root, gateName, record?.evidence);
	const result = requireGate(root, flags.feature, gateName, currentInputs);
	console.log(JSON.stringify({ gate: gateName, feature: flags.feature, ...result }));
	process.exit(result.code);
}

function cmdGateForce(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, {
		feature: { type: 'string', default: REPO_GATE_ID },
		reason: { type: 'string', default: '' },
	});
	const gateName = flags._[0];
	if (!gateName) { console.error('usage: bskel gate force <name> --reason "..." [--feature <id>]'); process.exit(14); }
	const state = forceGate(root, flags.feature, gateName, flags.reason);
	console.log(JSON.stringify(state.gates[gateName]));
	process.exit(EXIT.PASS);
}

function cmdGateShow(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, { feature: { type: 'string', default: REPO_GATE_ID } });
	console.log(JSON.stringify(loadState(root, flags.feature), null, 2));
	process.exit(0);
}

function cmdDoctor() {
	const root = repoRoot();
	const checks = [];
	checks.push({ name: 'inside a git repo', ok: Boolean(root), detail: root ?? 'not a git repo' });

	for (const bin of ['git', 'gh', 'rg']) {
		let ok = true;
		let detail = '';
		try {
			execFileSync(bin, ['--version'], { stdio: 'pipe' });
		} catch {
			ok = false;
			detail = 'not found on PATH';
		}
		checks.push({ name: `binary: ${bin}`, ok, detail });
	}

	for (const line of checks) {
		console.log(`${line.ok ? 'OK  ' : 'FAIL'}  ${line.name}${line.detail ? ` (${line.detail})` : ''}`);
	}
	const allOk = checks.every((c) => c.ok);
	process.exit(allOk ? 0 : 1);
}

function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case 'preflight':
			cmdPreflight(rest);
			break;
		case 'gate': {
			const sub = rest[0];
			const subArgs = rest.slice(1);
			if (sub === 'require') return cmdGateRequire(subArgs);
			if (sub === 'force') return cmdGateForce(subArgs);
			if (sub === 'show') return cmdGateShow(subArgs);
			usage();
			process.exit(14);
			break;
		}
		case 'doctor':
			cmdDoctor();
			break;
		default:
			usage();
			process.exit(cmd ? 14 : 0);
	}
}

main();
