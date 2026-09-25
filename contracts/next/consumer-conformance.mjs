import crypto from 'node:crypto';
import { bindingJson } from './identity.mjs';

export const IDENTITY_CONSUMER_RESULT_VERSION = 'sbf.identity-consumer-result/1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;

function fail(message) {
	throw new TypeError(message);
}

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, required, label) {
	if (!isPlainObject(value)) fail(`${label} must be a plain JSON object`);
	const actual = Object.keys(value).sort();
	const expected = [...required].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		fail(`${label} must contain exactly: ${expected.join(', ')}`);
	}
}

function sha256(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parsePack(packBytes) {
	const raw = Buffer.isBuffer(packBytes) ? packBytes : Buffer.from(packBytes, 'utf8');
	let pack;
	try {
		pack = JSON.parse(raw.toString('utf8'));
	} catch {
		fail('identity conformance pack must be valid UTF-8 JSON');
	}
	if (!isPlainObject(pack) || pack.identity_conformance !== 'sbf.identity-conformance/1') {
		fail('unsupported identity conformance pack');
	}
	for (const group of ['positive_cases', 'negative_cases', 'artifact_cases']) {
		if (!Array.isArray(pack[group])) fail(`identity conformance pack is missing ${group}`);
	}
	return { raw, pack };
}

function deepEqualJson(left, right) {
	return bindingJson(left) === bindingJson(right);
}

function expectedCases(pack) {
	const rows = [];
	for (const vector of pack.positive_cases) rows.push({ group: 'positive', vector });
	for (const vector of pack.negative_cases) rows.push({ group: 'negative', vector });
	for (const vector of pack.artifact_cases) rows.push({ group: 'artifact', vector });
	return rows;
}

function caseKey(group, name) {
	return `${group}:${name}`;
}

export function createConsumerResultTemplate(packBytes, {
	consumer,
	repository,
	commit_sha,
	implementation_path,
	command = '<consumer-owned command>',
} = {}) {
	const { raw, pack } = parsePack(packBytes);
	for (const [label, value] of Object.entries({ consumer, repository, commit_sha, implementation_path, command })) {
		if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
	}
	if (!COMMIT_RE.test(commit_sha)) fail('commit_sha must be a lowercase 40-hex commit');
	return {
		identity_consumer_result: IDENTITY_CONSUMER_RESULT_VERSION,
		consumer: { name: consumer, repository, commit_sha, implementation_path },
		conformance_pack: {
			identity_conformance: pack.identity_conformance,
			byte_sha256: sha256(raw),
		},
		execution: {
			command,
			exit_code: null,
			bskel_runtime_imported: false,
			bskel_runtime_spawned: false,
		},
		cases: expectedCases(pack).map(({ group, vector }) => ({
			group,
			name: vector.name,
			outcome: 'not-run',
			observed: null,
		})),
		summary: {
			total: expectedCases(pack).length,
			passed: 0,
			failed: 0,
			not_run: expectedCases(pack).length,
		},
	};
}

export function verifyConsumerConformanceResult(packBytes, result) {
	const { raw, pack } = parsePack(packBytes);
	exactKeys(result, ['identity_consumer_result', 'consumer', 'conformance_pack', 'execution', 'cases', 'summary'], 'IdentityConsumerResult');
	if (result.identity_consumer_result !== IDENTITY_CONSUMER_RESULT_VERSION) fail('unsupported identity_consumer_result');

	exactKeys(result.consumer, ['name', 'repository', 'commit_sha', 'implementation_path'], 'IdentityConsumerResult.consumer');
	for (const field of ['name', 'repository', 'implementation_path']) {
		if (typeof result.consumer[field] !== 'string' || result.consumer[field].length === 0) fail(`consumer.${field} must be a non-empty string`);
	}
	if (typeof result.consumer.commit_sha !== 'string' || !COMMIT_RE.test(result.consumer.commit_sha)) fail('consumer.commit_sha is invalid');

	exactKeys(result.conformance_pack, ['identity_conformance', 'byte_sha256'], 'IdentityConsumerResult.conformance_pack');
	if (result.conformance_pack.identity_conformance !== pack.identity_conformance) fail('consumer used a different identity conformance family');
	if (typeof result.conformance_pack.byte_sha256 !== 'string' || !SHA256_RE.test(result.conformance_pack.byte_sha256)) fail('conformance pack sha256 is invalid');
	const actualPackSha = sha256(raw);
	if (result.conformance_pack.byte_sha256 !== actualPackSha) fail('consumer conformance pack bytes do not match the reviewed pack');

	exactKeys(result.execution, ['command', 'exit_code', 'bskel_runtime_imported', 'bskel_runtime_spawned'], 'IdentityConsumerResult.execution');
	if (typeof result.execution.command !== 'string' || result.execution.command.length === 0) fail('execution.command must be a non-empty string');
	if (result.execution.exit_code !== 0) fail('consumer conformance execution did not exit 0');
	if (result.execution.bskel_runtime_imported !== false) fail('consumer conformance may not import bskel at runtime');
	if (result.execution.bskel_runtime_spawned !== false) fail('consumer conformance may not spawn bskel at runtime');

	if (!Array.isArray(result.cases)) fail('IdentityConsumerResult.cases must be an array');
	const expected = expectedCases(pack);
	const expectedByKey = new Map(expected.map(({ group, vector }) => [caseKey(group, vector.name), { group, vector }]));
	const actualByKey = new Map();
	for (const item of result.cases) {
		exactKeys(item, ['group', 'name', 'outcome', 'observed'], 'IdentityConsumerResult.case');
		if (!['positive', 'negative', 'artifact'].includes(item.group)) fail(`invalid consumer case group: ${String(item.group)}`);
		if (typeof item.name !== 'string' || item.name.length === 0) fail('consumer case name must be non-empty');
		const key = caseKey(item.group, item.name);
		if (actualByKey.has(key)) fail(`duplicate consumer case: ${key}`);
		if (!expectedByKey.has(key)) fail(`unexpected consumer case: ${key}`);
		if (item.outcome !== 'pass') fail(`consumer case did not pass: ${key}`);
		actualByKey.set(key, item);
	}
	if (actualByKey.size !== expectedByKey.size) {
		const missing = [...expectedByKey.keys()].filter((key) => !actualByKey.has(key));
		fail(`consumer result is missing cases: ${missing.join(', ')}`);
	}

	for (const [key, { group, vector }] of expectedByKey) {
		const item = actualByKey.get(key);
		if (group === 'positive') {
			if (!deepEqualJson(item.observed, vector.expected)) fail(`positive consumer observation mismatch: ${key}`);
		} else if (group === 'negative') {
			if (!isPlainObject(item.observed)) fail(`negative consumer observation must be an object: ${key}`);
			exactKeys(item.observed, ['error'], 'IdentityConsumerResult.negative.observed');
			if (typeof item.observed.error !== 'string' || !(new RegExp(vector.error_pattern)).test(item.observed.error)) {
				fail(`negative consumer error mismatch: ${key}`);
			}
		} else if (!deepEqualJson(item.observed, vector.expected_ref)) {
			fail(`artifact consumer observation mismatch: ${key}`);
		}
	}

	exactKeys(result.summary, ['total', 'passed', 'failed', 'not_run'], 'IdentityConsumerResult.summary');
	if (result.summary.total !== expected.length || result.summary.passed !== expected.length || result.summary.failed !== 0 || result.summary.not_run !== 0) {
		fail('consumer summary does not match the verified case set');
	}

	return {
		ok: true,
		consumer: result.consumer,
		conformance_pack_sha256: actualPackSha,
		verified_cases: expected.length,
	};
}


export const IDENTITY_CONSUMER_SET_VERSION = 'sbf.identity-consumer-set/1';

export function verifyRequiredConsumerSet(packBytes, results, { required_repositories = [] } = {}) {
	if (!Array.isArray(results) || results.length === 0) fail('consumer result set must be a non-empty array');
	if (!Array.isArray(required_repositories)) fail('required_repositories must be an array');
	if (required_repositories.some((repo) => typeof repo !== 'string' || repo.length === 0)) {
		fail('required_repositories must contain non-empty strings');
	}
	if (new Set(required_repositories).size !== required_repositories.length) fail('required_repositories contains duplicates');

	const verified = results.map((result) => verifyConsumerConformanceResult(packBytes, result));
	const byRepository = new Map();
	for (const entry of verified) {
		const repository = entry.consumer.repository;
		if (byRepository.has(repository)) fail(`duplicate consumer repository result: ${repository}`);
		byRepository.set(repository, entry);
	}

	if (required_repositories.length > 0) {
		const required = new Set(required_repositories);
		const unexpected = [...byRepository.keys()].filter((repository) => !required.has(repository));
		if (unexpected.length > 0) fail(`unexpected consumer repositories: ${unexpected.join(', ')}`);
		const missing = required_repositories.filter((repository) => !byRepository.has(repository));
		if (missing.length > 0) fail(`missing required consumer repositories: ${missing.join(', ')}`);
	}

	const { raw } = parsePack(packBytes);
	return {
		identity_consumer_set: IDENTITY_CONSUMER_SET_VERSION,
		conformance_pack_sha256: sha256(raw),
		required_repositories: [...required_repositories],
		consumers: [...byRepository.values()]
			.map((entry) => ({
				name: entry.consumer.name,
				repository: entry.consumer.repository,
				commit_sha: entry.consumer.commit_sha,
				implementation_path: entry.consumer.implementation_path,
				verified_cases: entry.verified_cases,
			}))
			.sort((left, right) => left.repository.localeCompare(right.repository)),
	};
}
