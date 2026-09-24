import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildEmbodimentContract, assertEmbodimentContract } from '../lib/embodiment-contract.mjs';

const spec = {
	feature_id: '001-sh5-embodiment',
	feature_uid: '8b98f0d6-7047-47b6-aeb8-e01e0a6b4834',
	provenance: 'robotis_sh5_mjlab/HANDOFF.md',
	body: {
		id: 'robotis-sh5',
		kind: 'robot',
		runtime: 'mujoco',
		frame: 'base_link:x-forward,y-left,z-up:m-rad-s',
		simulation_only: true,
	},
	skills: [{
		operation_id: 'invokeCanColorSort',
		skill_id: 'sh5.can_color_sort.v1',
		enabled: true,
		provenance: 'pretrained d150_joint closed-loop smoke 3/3',
	}],
};

test('embodiment spec compiles to sbf_contract/9', () => {
	const contract = buildEmbodimentContract(spec);
	assert.equal(contract.sbf_contract, '9');
	assert.equal(contract.source.adapter, 'robot-embodiment');
	assert.equal(contract.operations.invokeCanColorSort.verb, 'SKILL');
	assert.equal(contract.operations.invokeCanColorSort.path, 'sh5.can_color_sort.v1');
	assert.equal(contract.operations.observeBody.verb, 'OBSERVE');
	assert.equal(contract.operations.cancelExecution.verb, 'CANCEL');
	assert.equal(assertEmbodimentContract(contract), true);
	const bytes = JSON.stringify(contract, null, 2) + '\n';
	assert.match(crypto.createHash('sha256').update(bytes).digest('hex'), /^[a-f0-9]{64}$/);
});

test('v0.1 fails closed for real hardware', () => {
	assert.throws(() => buildEmbodimentContract({
		...spec,
		body: { ...spec.body, simulation_only: false },
	}), /simulation_only=true/);
});

test('perception uncertainty is explicit', () => {
	const contract = buildEmbodimentContract(spec);
	const item = contract.operations.observeBody.responseSchema.properties.objects.items;
	assert.deepEqual(item.properties.reachable.enum, [true, false, 'unknown']);
	assert.deepEqual(item.properties.graspable.enum, [true, false, 'unknown']);
});
