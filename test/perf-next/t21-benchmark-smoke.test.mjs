import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'test', 'perf-next', 'legacy-cache-benchmark.mjs');

test('T21 legacy-cache benchmark emits machine-readable semantic-equivalence evidence', async () => {
	const output = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [SCRIPT, '--adapter', 'javascript-express', '--samples', '1', '--profile-id', 'ci-smoke-unapproved'], {
			cwd: ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`benchmark exit ${code}: ${stderr}`)));
	});
	const report = JSON.parse(output);
	assert.equal(report.schema, 'sbf.t21-legacy-cache-benchmark/1');
	assert.equal(report.environment.profile_id, 'ci-smoke-unapproved');
	assert.equal(report.workloads.length, 1);
	const workload = report.workloads[0];
	assert.equal(workload.id, 'javascript-express');
	assert.equal(workload.samples, 1);
	assert.equal(workload.semantic_equivalence, true);
	for (const field of ['legacy_direct_p95_ms', 'cache_cold_p95_ms', 'cache_hit_p95_ms']) {
		assert.equal(Number.isFinite(workload[field]) && workload[field] >= 0, true, `${field} must be finite and non-negative`);
	}
});
