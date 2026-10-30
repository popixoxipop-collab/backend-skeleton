#!/usr/bin/env node
// Narrow, local-only verification of the BSKEL -> BECODER -> BEVAL context seam.
// Supply the two peer checkouts explicitly. No model, database, server or CI job runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runScan } from '../scanners/index.mjs';
import { buildContract } from '../contracts/emit.mjs';
import { buildReconciliation } from '../contracts/openapi.mjs';

const { values } = parseArgs({ options: {
	'becoder-dir': { type: 'string' }, 'beval-dir': { type: 'string' }, out: { type: 'string' },
} });
if (!values['becoder-dir'] || !values['beval-dir']) {
	throw new Error('usage: node scripts/context-triad-smoke.mjs --becoder-dir <checkout> --beval-dir <checkout> [--out <report.json>]');
}
const bskelDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bins = {
	bskel: path.join(bskelDir, 'bin/bskel.mjs'),
	becoder: path.resolve(values['becoder-dir'], 'bin/becoder.mjs'),
	beval: path.resolve(values['beval-dir'], 'bin/beval.mjs'),
};
for (const bin of Object.values(bins)) assert.ok(fs.statSync(bin).isFile(), `missing CLI: ${bin}`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'triad-context-smoke-'));
const repo = path.join(temporary, 'backend');
fs.mkdirSync(repo);
const checks = [];
const write = (file, text) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const jsonFile = (name, value) => {
	const file = path.join(temporary, name);
	write(file, `${JSON.stringify(value, null, 2)}\n`);
	return file;
};
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
	encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
	: value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
		: value;
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const byteHash = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
function cli(name, args, { allowFailure = false } = {}) {
	const result = spawnSync(process.execPath, [bins[name], ...args], {
		cwd: repo, encoding: 'utf8', timeout: 20000, maxBuffer: 4194304,
	});
	if (result.error) throw result.error;
	if (!allowFailure) assert.equal(result.status, 0, `${name} failed: ${result.stderr}\n${result.stdout}`);
	let document;
	try { document = JSON.parse(result.stdout); }
	catch { throw new Error(`${name} did not produce JSON: ${result.stdout}\n${result.stderr}`); }
	return { status: result.status, document };
}
function check(name, action) {
	action();
	checks.push({ name, passed: true });
}

try {
	write(path.join(repo, 'app/widgets.py'), [
		'from fastapi import APIRouter', '',
		'router = APIRouter(prefix="/widgets", tags=["widgets"])', '',
		'@router.get("/{widget_id}")', 'def get_widget(widget_id: str):', '    return {"id": widget_id}', '',
		'@router.post("")', 'def create_widget():', '    return {"id": "created"}', '',
	].join('\n'));
	write(path.join(repo, 'requirements.txt'), 'fastapi>=0.100\n');
	write(path.join(repo, 'README.md'), '# Widget fixture\n\nRoutes are in app/widgets.py.\n');
	write(path.join(repo, 'AGENTS.md'), '# Conventions\n\nPreserve route paths and unknown contract facts.\n');
	write(path.join(repo, 'unrelated.txt'), 'Unrelated fixture history.\n'.repeat(5000));
	const response = (description) => ({ description, content: {
		'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
	} });
	const openapi = { openapi: '3.1.0', info: { title: 'Widget fixture', version: '1.0.0' }, paths: {
		'/widgets/{widget_id}': { get: {
			operationId: 'getWidget', security: [],
			parameters: [{ name: 'widget_id', in: 'path', required: true, schema: { type: 'string' } }],
			responses: { 200: response('Widget') },
		} },
		'/widgets': { post: { operationId: 'createWidget', responses: { 201: response('Created') } } },
	} };
	write(path.join(repo, 'openapi.json'), `${JSON.stringify(openapi, null, 2)}\n`);
	const scan = runScan({ repoRoot: repo, terms: ['widgets'] });
	assert.equal(scan.adapter, 'python-fastapi');
	const module = scan.related_modules.find((item) => item.module === 'widgets');
	assert.ok(module, 'actual scanner must discover widgets');
	const reconciliation = buildReconciliation({ filePath: path.join(repo, 'openapi.json'), module });
	const contract = buildContract({
		featureId: '001-widgets', featureUid: '11111111-1111-4111-8111-111111111111',
		scanReport: scan, module: module.module, openapi: reconciliation,
	});
	assert.deepEqual(Object.keys(contract.operations), ['getWidget', 'createWidget']);
	const contractPath = 'specs/001-widgets/contracts/001-widgets.schema.json';
	write(path.join(repo, contractPath), `${JSON.stringify(contract, null, 2)}\n`);
	git('init', '-q', '--object-format=sha1'); git('config', 'user.name', 'Triad context fixture');
	git('config', 'user.email', 'fixture@local.invalid'); git('add', '.');
	git('commit', '-qm', 'FastAPI fixture with BSKEL-generated contract');
	const commit = git('rev-parse', 'HEAD');
	const packet = cli('bskel', ['context', 'pack', '--contract', contractPath,
		'--revision', commit, '--files', 'app/widgets.py,openapi.json', '--json']).document;
	const packetFile = jsonFile('packet.json', packet);
	const handoffDir = path.join(temporary, 'handoff');
	const planned = cli('becoder', ['plan', '--context-packet', packetFile, '--handoff-out', handoffDir, '--json']).document;
	const plannedFile = jsonFile('planned.json', planned);
	const evaluate = (packetPath = packetFile, planPath = plannedFile, expected = commit) => cli('beval', [
		'context', 'check', '--packet', packetPath, '--plan', planPath,
		'--repo', repo, '--expect-commit', expected, '--json',
	], { allowFailure: true });
	// BEVAL status assertion is intentionally pinned to the public context-check result.
	const outcome = (result) => result.document.status;

	check('actual scanner -> packet -> existing planner -> independent verifier', () => {
		const evaluated = evaluate();
		assert.equal(evaluated.status, 0);
		assert.equal(outcome(evaluated), 'verified');
		assert.ok(fs.statSync(path.join(handoffDir, 'AGENT.md')).isFile());
		assert.equal(packet.sources.some((item) => item.path === 'unrelated.txt'), false);
	});
	check('legacy planning remains identical; explicit empty security stays distinct from missing', () => {
		const legacy = cli('becoder', ['plan', '--contract', path.join(repo, contractPath), '--json']).document;
		assert.deepEqual(planned.plan, legacy.plan);
		assert.deepEqual(planned.readWarnings, legacy.readWarnings);
		assert.equal(planned.plan.operations['001-widgets:getWidget'].securityStatus, 'explicit');
		assert.equal(planned.plan.operations['001-widgets:createWidget'].securityStatus, 'ambiguous');
	});
	check('working-tree edits cannot replace the pinned Git evidence', () => {
		write(path.join(repo, 'app/widgets.py'), '# uncommitted unrelated replacement\n');
		assert.equal(outcome(evaluate()), 'verified');
	});
	check('different expected commit is rejected even with identical tree', () => {
		git('commit', '--allow-empty', '-qm', 'Same tree, different intended commit');
		const otherCommit = git('rev-parse', 'HEAD');
		assert.notEqual(otherCommit, commit);
		assert.equal(git('rev-parse', `${otherCommit}^{tree}`), git('rev-parse', `${commit}^{tree}`));
		assert.equal(outcome(evaluate(packetFile, plannedFile, otherCommit)), 'invalid');
	});
	check('rehashed packet and replanned forged contract fail independent Git verification', () => {
		const forged = clone(packet);
		const changed = JSON.parse(forged.contract.content);
		changed.operations.createWidget.sourceSecurity = [];
		const content = `${JSON.stringify(changed, null, 2)}\n`;
		forged.budget.used_bytes += Buffer.byteLength(content) - forged.contract.bytes;
		forged.contract.content = content;
		forged.contract.bytes = Buffer.byteLength(content);
		forged.contract.sha256 = byteHash(content);
		forged.contract.blob_oid = createHash('sha1').update(`blob ${forged.contract.bytes}\0`).update(content).digest('hex');
		delete forged.packet_sha256; forged.packet_sha256 = digest(forged);
		const forgedFile = jsonFile('forged-packet.json', forged);
		const forgedPlan = cli('becoder', ['plan', '--context-packet', forgedFile, '--json']).document;
		assert.equal(outcome(evaluate(forgedFile, jsonFile('forged-plan.json', forgedPlan))), 'invalid');
	});
	check('lost operation remains invalid after handoff and plan checksums are recomputed', () => {
		const lost = clone(planned);
		delete lost.plan.operations['001-widgets:createWidget'];
		lost.context_handoff.operation_ids = ['getWidget'];
		lost.context_handoff.operations = lost.context_handoff.operations.filter((item) => item.operation_id !== 'createWidget');
		lost.context_handoff.plan_sha256 = digest(lost.plan);
		assert.equal(outcome(evaluate(packetFile, jsonFile('lost-operation.json', lost))), 'invalid');
	});
	check('weakened security projection is rejected after all consumer checksums are recomputed', () => {
		const weakened = clone(planned);
		weakened.plan.operations['001-widgets:createWidget'].securityStatus = 'explicit';
		weakened.context_handoff.plan_sha256 = digest(weakened.plan);
		const binding = weakened.context_handoff.operations.find((item) => item.operation_id === 'createWidget');
		binding.plan_operation_sha256 = digest(weakened.plan.operations[binding.plan_operation_id]);
		assert.equal(outcome(evaluate(packetFile, jsonFile('weakened-plan.json', weakened))), 'invalid');
	});
	check('budget omissions are valid evidence but yield incomplete, never verified', () => {
		const partial = cli('bskel', ['context', 'pack', '--contract', contractPath,
			'--revision', commit, '--files', 'app/widgets.py,openapi.json', '--max-files', '2', '--json']).document;
		assert.equal(partial.selection.complete, false);
		const partialFile = jsonFile('partial-packet.json', partial);
		const partialPlan = cli('becoder', ['plan', '--context-packet', partialFile, '--json']).document;
		assert.equal(outcome(evaluate(partialFile, jsonFile('partial-plan.json', partialPlan))), 'incomplete');
	});
	const report = {
		schema: 'triad.context-smoke/1', scope: 'context-and-plan-traceability',
		fixture: { adapter: scan.adapter, operation_count: Object.keys(contract.operations).length,
			commit, selected_files: packet.budget.used_files, selected_utf8_bytes: packet.budget.used_bytes,
			contract_warnings: contract.warnings.length },
		checks, passed: checks.length, failed: 0,
		implementation_quality_evaluated: false, model_performance_evaluated: false,
	};
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (values.out) write(path.resolve(values.out), serialized);
	process.stdout.write(serialized);
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
}
