import { hasOnlyKeys, isPlainObject } from './_util.mjs';

export const TASK_PACKET_CONTRACT = 'sbf.adapter-task-packet/1';

export function createAdapterTaskPacket({
	taskId,
	targetId,
	baseSha,
	writeScope,
	fixtures,
	mandatoryTests,
	constraints = [],
}) {
	const packet = {
		contract: TASK_PACKET_CONTRACT,
		taskId,
		targetId,
		baseSha,
		writeScope: [...writeScope],
		fixtures: [...fixtures],
		mandatoryTests: [...mandatoryTests],
		constraints: [
			'no core-schema, package manifest, lockfile, or CLI edits without an owner-approved change request',
			'no automatic package install/import/target execution from an adapter manifest',
			'unknown or unsupported semantics stay explicit instead of being guessed',
			...constraints,
		],
	};
	const validation = validateAdapterTaskPacket(packet);
	if (!validation.ok) throw new TypeError(validation.errors.join('; '));
	return packet;
}

export function validateAdapterTaskPacket(packet) {
	const errors = [];
	if (!isPlainObject(packet) || !hasOnlyKeys(packet, [
		'contract', 'taskId', 'targetId', 'baseSha', 'writeScope', 'fixtures', 'mandatoryTests', 'constraints',
	])) return { ok: false, errors: ['packet must use the exact task-packet keys'] };
	if (packet.contract !== TASK_PACKET_CONTRACT) errors.push(`contract must equal ${TASK_PACKET_CONTRACT}`);
	if (typeof packet.taskId !== 'string' || packet.taskId.length === 0) errors.push('taskId must be non-empty');
	if (typeof packet.targetId !== 'string' || packet.targetId.length === 0) errors.push('targetId must be non-empty');
	if (!/^[0-9a-f]{40}$/.test(packet.baseSha ?? '')) errors.push('baseSha must be a 40-character git SHA');
	for (const key of ['writeScope', 'fixtures', 'mandatoryTests', 'constraints']) {
		if (!Array.isArray(packet[key]) || packet[key].length === 0 || packet[key].some((x) => typeof x !== 'string' || x.length === 0)) {
			errors.push(`${key} must be a non-empty array of strings`);
		}
	}
	return { ok: errors.length === 0, errors };
}

export function renderTaskPacketMarkdown(packet) {
	const validation = validateAdapterTaskPacket(packet);
	if (!validation.ok) throw new TypeError(validation.errors.join('; '));
	const bullets = (items) => items.map((x) => `- ${x}`).join('\n');
	return [
		`# ${packet.taskId} · ${packet.targetId}`,
		'',
		`Base: \`${packet.baseSha}\``,
		'',
		'## Write scope',
		'',
		bullets(packet.writeScope),
		'',
		'## Fixtures',
		'',
		bullets(packet.fixtures),
		'',
		'## Mandatory tests',
		'',
		bullets(packet.mandatoryTests),
		'',
		'## Constraints',
		'',
		bullets(packet.constraints),
	].join('\n');
}
