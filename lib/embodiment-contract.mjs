import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';

function objectSchema(properties, required = []) {
	return {
		type: 'object',
		additionalProperties: false,
		...(required.length ? { required } : {}),
		properties,
	};
}

export function buildEmbodimentContract(spec) {
	const featureId = spec?.feature_id;
	const featureUid = spec?.feature_uid;
	if (typeof featureId !== 'string' || !featureId) throw new Error('feature_id is required');
	if (typeof featureUid !== 'string' || !featureUid) throw new Error('feature_uid is required');
	if (spec?.body?.simulation_only !== true) throw new Error('v0.1 requires body.simulation_only=true');
	if (!Array.isArray(spec?.skills) || spec.skills.length === 0) throw new Error('at least one skill is required');

	const perception = objectSchema({
		snapshot_id: { type: 'string', minLength: 1 },
		observed_at: { type: 'string', format: 'date-time' },
		body_id: { const: spec.body.id },
		frame: { const: spec.body.frame },
		objects: {
			type: 'array',
			items: objectSchema({
				id: { type: 'string', minLength: 1 },
				type: { type: 'string', minLength: 1 },
				distance_m: { type: ['number', 'null'], minimum: 0 },
				bearing_rad: { type: ['number', 'null'] },
				reachable: { enum: [true, false, 'unknown'] },
				graspable: { enum: [true, false, 'unknown'] },
				confidence: { type: 'number', minimum: 0, maximum: 1 },
			}, ['id', 'type', 'distance_m', 'bearing_rad', 'reachable', 'graspable', 'confidence']),
		},
	}, ['snapshot_id', 'observed_at', 'body_id', 'frame', 'objects']);

	const executionReceipt = objectSchema({
		request_id: { type: 'string', format: 'uuid' },
		state: { enum: ['accepted', 'running', 'succeeded', 'failed', 'cancelled'] },
		skill_id: { type: 'string', minLength: 1 },
		evidence_id: { type: ['string', 'null'] },
	}, ['request_id', 'state', 'skill_id', 'evidence_id']);

	const operations = {
		describeBody: {
			verb: 'OBSERVE',
			path: 'body:' + spec.body.id,
			pathParams: {},
			body: false,
			provenance: 'embodiment-spec/body',
			responseSchema: objectSchema({
				body_id: { const: spec.body.id },
				kind: { const: spec.body.kind },
				runtime: { const: spec.body.runtime },
				frame: { const: spec.body.frame },
				simulation_only: { const: true },
			}, ['body_id', 'kind', 'runtime', 'frame', 'simulation_only']),
		},
		observeBody: {
			verb: 'OBSERVE',
			path: 'perception:' + spec.body.id,
			pathParams: {},
			body: false,
			provenance: 'embodiment-spec/perception',
			responseSchema: perception,
		},
		getExecution: {
			verb: 'OBSERVE',
			path: 'execution:' + spec.body.id,
			pathParams: {},
			body: true,
			provenance: 'embodiment-spec/execution',
			requestBodyRequired: true,
			requestBodySchema: objectSchema({ request_id: { type: 'string', format: 'uuid' } }, ['request_id']),
			responseSchema: executionReceipt,
		},
		cancelExecution: {
			verb: 'CANCEL',
			path: 'execution:' + spec.body.id,
			pathParams: {},
			body: true,
			provenance: 'embodiment-spec/execution',
			requestBodyRequired: true,
			requestBodySchema: objectSchema({ request_id: { type: 'string', format: 'uuid' } }, ['request_id']),
			responseSchema: executionReceipt,
		},
	};

	for (const skill of spec.skills) {
		if (!skill?.enabled) continue;
		if (typeof skill.operation_id !== 'string' || !skill.operation_id) throw new Error('skill.operation_id is required');
		if (Object.hasOwn(operations, skill.operation_id)) throw new Error('duplicate operation_id: ' + skill.operation_id);
		operations[skill.operation_id] = {
			verb: 'SKILL',
			path: skill.skill_id,
			pathParams: {},
			body: true,
			provenance: skill.provenance ?? 'embodiment-spec/skill',
			requestBodyRequired: true,
			requestBodySchema: objectSchema({
				request_id: { type: 'string', format: 'uuid' },
				perception_snapshot_id: { type: 'string', minLength: 1 },
				target_id: { type: ['string', 'null'] },
				destination_id: { type: ['string', 'null'] },
			}, ['request_id', 'perception_snapshot_id', 'target_id', 'destination_id']),
			responseSchema: executionReceipt,
		};
	}

	const contract = {
		sbf_contract: '9',
		feature_id: featureId,
		feature_uid: featureUid,
		source: {
			adapter: 'robot-embodiment',
			module: spec.body.id,
			provenance: spec.provenance ?? 'embodiment-spec/1',
		},
		operations,
		warnings: [],
		completeness: {
			status: 'complete',
			operation_count: Object.keys(operations).length,
			endpoint_count: Object.keys(operations).length,
		},
	};
	const checked = validateAgainstSchema('feature-contract.schema.json', contract);
	if (!checked.ok) throw new Error('generated contract is invalid: ' + formatSchemaErrors(checked.errors).join('; '));
	return contract;
}

export function assertEmbodimentContract(contract) {
	const checked = validateAgainstSchema('feature-contract.schema.json', contract);
	if (!checked.ok) throw new Error('invalid sbf contract: ' + formatSchemaErrors(checked.errors).join('; '));
	if (contract.source?.adapter !== 'robot-embodiment') throw new Error('contract source.adapter must be robot-embodiment');
	for (const [id, op] of Object.entries(contract.operations ?? {})) {
		if (!['OBSERVE', 'SKILL', 'CANCEL'].includes(op.verb)) throw new Error('unsupported embodiment verb for ' + id + ': ' + op.verb);
	}
	return true;
}
