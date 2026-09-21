// G6-D: deterministic, read-only execution preview. This module deliberately does not spawn
// Python or Unreal; a caller can inspect every process boundary before an apply-capable runner is
// introduced. Runtime manifests remain the only source of scripts, receipts, and write targets.
import path from 'node:path';

function unix(value) {
	return value.split(path.sep).join('/');
}

function target(write) {
	return { ...write, path: unix(write.path) };
}

export function buildGameplayEmitPlan(manifest, contract) {
	const loopId = manifest.loop_id;
	const contractFile = path.join('specs', loopId, 'contracts', `${loopId}.game.json`);
	const compiler = {
		id: 'compile-game-plan', kind: 'python',
		program: 'python',
		args: [unix(manifest.compiler.script), '--contract', unix(contractFile), '--world-anchors', unix(manifest.compiler.world_anchors), '--out', unix(manifest.compiler.output)],
		writes: [{ kind: 'file', path: unix(manifest.compiler.output) }],
	};
	const editorStep = (step, phase) => ({
		id: step.id, phase, kind: 'unreal-editor-python',
		project_file: unix(manifest.runtime.project_file), script: unix(step.script), args: step.args.map(unix), result_file: unix(step.result_file),
		[phase === 'emit' ? 'writes' : 'reads']: (step[phase === 'emit' ? 'writes' : 'reads'] ?? []).map(target),
	});
	return {
		schema: 'sbf.gameplay-emit-plan/1', loop_id: loopId, contract_file: unix(contractFile),
		manifest_file: unix(manifest.file), exclusive_session: manifest.runtime.exclusive_session,
		compiler, emit_steps: manifest.runtime.emit_steps.map((step) => editorStep(step, 'emit')),
		verify_steps: manifest.runtime.verify_steps.map((step) => editorStep(step, 'verify')),
		notes: [
			'This is a dry-run execution plan; no Python or Unreal process was started.',
			'Each Unreal step must produce SCRIPT_DONE_OK in its declared result_file before a future runner can advance.',
		],
	};
}
