import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Gates a feature can plausibly have. `required` ones must be `pass` for overall verdict PASS;
// `handles` is optional -- not every feature needs UUID handles, so "not_run" there is fine.
const GATE_SPECS = [
	{ name: 'preflight', scope: 'repo', required: true },
	{ name: 'scan', scope: 'feature', required: true },
	{ name: 'contract', scope: 'feature', required: true },
	{ name: 'handles', scope: 'feature', required: false },
];

export function collectGateStatuses(root, featureId, { getGate, requireGate, gateInputsFor }) {
	const results = [];
	for (const spec of GATE_SPECS) {
		const scopeId = spec.scope === 'repo' ? '_repo' : featureId;
		const record = getGate(root, scopeId, spec.name);
		const currentInputs = gateInputsFor(spec.name, root, scopeId, record?.evidence);
		const result = requireGate(root, scopeId, spec.name, currentInputs);
		results.push({ gate: spec.name, required: spec.required, ...result });
	}
	return results;
}

function detectBuildCommand(repoRoot) {
	if (fs.existsSync(path.join(repoRoot, 'gradlew'))) {
		return { tool: 'gradle', cmd: './gradlew', args: ['compileJava', '--console=plain'] };
	}
	if (fs.existsSync(path.join(repoRoot, 'pom.xml'))) {
		return { tool: 'maven', cmd: './mvnw', args: ['compile', '-q'] };
	}
	if (fs.existsSync(path.join(repoRoot, 'package.json'))) {
		return { tool: 'npm', cmd: 'npm', args: ['run', 'build', '--if-present'] };
	}
	return null;
}

export function runBuildCheck(repoRoot) {
	const build = detectBuildCommand(repoRoot);
	if (!build) return { ran: false, ok: null, tool: null, message: 'no recognized build tool (gradlew/pom.xml/package.json) found' };
	try {
		execFileSync(build.cmd, build.args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
		return { ran: true, ok: true, tool: build.tool };
	} catch (err) {
		return { ran: true, ok: false, tool: build.tool, message: (err.stdout || err.message || '').toString().split('\n').slice(-30).join('\n') };
	}
}

export function checkArtifacts(root, featureId) {
	const specDir = path.join(root, 'specs', featureId);
	const checks = [];
	const contractPath = path.join(specDir, 'contracts', `${featureId}.schema.json`);
	checks.push({ artifact: 'contract', path: path.relative(root, contractPath), exists: fs.existsSync(contractPath) });

	const migrationPath = path.join(specDir, 'handles', 'migration.sql');
	if (fs.existsSync(migrationPath)) {
		checks.push({ artifact: 'handles migration', path: path.relative(root, migrationPath), exists: true });
	}
	return checks;
}
