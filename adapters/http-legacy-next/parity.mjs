import { createHash } from 'node:crypto';
import path from 'node:path';

// T11-04 pre-freeze semantic parity harness.
//
// This module deliberately speaks only in the legacy HTTP adapters' already-observed vocabulary.
// It does not define T01/T02/T03's future normalized IR. A future next projection can earn parity
// by producing this snapshot shape, while the stable sbf.scan-report/2 remains the oracle during
// migration.
//
// This module is outside scanners/registry.mjs automatic adapter registration.

export const LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA = 'sbf.http-legacy-semantic-snapshot/1';

function plainDto(dto) {
	if (typeof dto === 'string') return { className: dto, file: null };
	return { className: dto?.className ?? dto?.name ?? null, file: dto?.file ?? null };
}

function plainEnum(value) {
	return {
		name: value?.name ?? null,
		constants: Array.isArray(value?.constants) ? [...value.constants] : [],
		file: value?.file ?? null,
	};
}

function plainEntity(value) {
	return {
		className: value?.className ?? null,
		table: value?.table ?? null,
		idField: value?.idField ?? null,
		idFieldType: value?.idFieldType ?? null,
		idFieldIsUuid: value?.idFieldIsUuid ?? null,
		file: value?.file ?? null,
	};
}

function plainEndpoint(value) {
	return {
		method: value?.method ?? null,
		path: value?.path ?? null,
		operationId: value?.operationId ?? null,
		file: value?.file ?? null,
	};
}

function plainController(value) {
	return {
		className: value?.className ?? null,
		basePath: value?.basePath ?? null,
		file: value?.file ?? null,
		endpoints: (value?.endpoints ?? []).map(plainEndpoint),
	};
}

function plainModule(value) {
	return {
		module: value?.module ?? null,
		controllers: (value?.controllers ?? []).map(plainController),
		entities: (value?.entities ?? []).map(plainEntity),
		enums: (value?.enums ?? []).map(plainEnum),
		dtos: (value?.dtos ?? []).map(plainDto),
	};
}

// A scan report's `.file` values are absolute and the report does not say which directory was scanned,
// so by default the snapshot and its digest depend on where the checkout lives. Passing `root`, the
// repoRoot the scan was given, rewrites each `.file` to a POSIX path relative to it. A `.file` that is
// not below `root` throws instead of staying machine-specific.
function relativeFileMapper(root) {
	if (typeof root !== 'string' || root === '') throw new TypeError('root must be a non-empty string');
	return (file) => {
		if (file === null) return null;
		const relative = path.relative(root, file);
		if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
			throw new Error(`scan report file "${file}" is not under root "${root}"`);
		}
		return relative.split(path.sep).join('/');
	};
}

function relocateFiles(modules, toRelative) {
	for (const module of modules) {
		for (const controller of module.controllers) {
			controller.file = toRelative(controller.file);
			for (const endpoint of controller.endpoints) endpoint.file = toRelative(endpoint.file);
		}
		for (const item of [...module.entities, ...module.enums, ...module.dtos]) item.file = toRelative(item.file);
	}
}

export function legacyHttpSemanticSnapshot(report, { root } = {}) {
	if (!report || typeof report !== 'object' || report.schema !== 'sbf.scan-report/2') {
		throw new Error('legacy HTTP semantic snapshot requires sbf.scan-report/2');
	}
	const toRelative = root === undefined ? null : relativeFileMapper(root);
	const modules = (report.related_modules ?? []).map(plainModule);
	if (toRelative) relocateFiles(modules, toRelative);
	return {
		schema: LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA,
		adapter: report.adapter ?? null,
		confidence: report.confidence ?? null,
		api_surface_source: report.api_surface_source ?? null,
		verdict: report.verdict ?? null,
		path_prefix_signals: JSON.parse(JSON.stringify(report.path_prefix_signals ?? [])),
		modules,
		files_read: [...(report.files_read ?? [])],
	};
}

function pathJoin(base, key) {
	return /^[0-9]+$/.test(String(key)) ? `${base}[${key}]` : (base ? `${base}.${key}` : String(key));
}

function diffValue(expected, actual, at, out, limit) {
	if (out.length >= limit) return;
	if (Object.is(expected, actual)) return;

	const expectedArray = Array.isArray(expected);
	const actualArray = Array.isArray(actual);
	if (expectedArray || actualArray) {
		if (!(expectedArray && actualArray)) {
			out.push({ path: at, kind: 'type', expected, actual });
			return;
		}
		if (expected.length !== actual.length) {
			out.push({ path: at, kind: 'array-length', expected: expected.length, actual: actual.length });
			if (out.length >= limit) return;
		}
		for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
			diffValue(expected[i], actual[i], pathJoin(at, i), out, limit);
			if (out.length >= limit) return;
		}
		return;
	}

	const expectedObject = expected && typeof expected === 'object';
	const actualObject = actual && typeof actual === 'object';
	if (expectedObject || actualObject) {
		if (!(expectedObject && actualObject)) {
			out.push({ path: at, kind: 'type', expected, actual });
			return;
		}
		const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
		for (const key of keys) {
			if (!Object.hasOwn(expected, key)) {
				out.push({ path: pathJoin(at, key), kind: 'unexpected', expected: undefined, actual: actual[key] });
			} else if (!Object.hasOwn(actual, key)) {
				out.push({ path: pathJoin(at, key), kind: 'missing', expected: expected[key], actual: undefined });
			} else {
				diffValue(expected[key], actual[key], pathJoin(at, key), out, limit);
			}
			if (out.length >= limit) return;
		}
		return;
	}

	out.push({ path: at, kind: 'value', expected, actual });
}

function stableJsonValue(value) {
	if (Array.isArray(value)) return value.map(stableJsonValue);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]),
		);
	}
	return value;
}

// Regression-only semantic digest. This is NOT sbf.contract-ref/1's exact-byte contract_hash and
// must never be substituted for it. Its sole purpose is to pin T11 fixture/corpus semantics while
// allowing irrelevant JSON object key order to vary.
export function legacyHttpSemanticDigest(snapshotOrReport, { root } = {}) {
	const isReport = snapshotOrReport?.schema === 'sbf.scan-report/2';
	if (root !== undefined && !isReport) throw new TypeError('root only applies to a scan report, not to a semantic snapshot');
	const snapshot = isReport ? legacyHttpSemanticSnapshot(snapshotOrReport, { root }) : snapshotOrReport;
	if (!snapshot || snapshot.schema !== LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA) {
		throw new Error('legacy HTTP semantic digest requires a semantic snapshot or sbf.scan-report/2');
	}
	const bytes = JSON.stringify(stableJsonValue(snapshot));
	return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

export function compareLegacyHttpSemanticSnapshots(expected, actual, { maxDiffs = 100 } = {}) {
	if (!Number.isInteger(maxDiffs) || maxDiffs < 1 || maxDiffs > 1000) {
		throw new RangeError('maxDiffs must be an integer from 1 through 1000');
	}
	const diffs = [];
	diffValue(expected, actual, '', diffs, maxDiffs);
	return {
		equal: diffs.length === 0,
		diffs,
		truncated: diffs.length >= maxDiffs,
	};
}

// `expectedRoot` and `actualRoot` are the repoRoot of each scan; give both or neither. Without them the
// two reports are compared with their `.file` values as reported, which differ whenever the two
// checkouts live in different directories.
export function compareLegacyHttpReports(expectedReport, actualReport, options = {}) {
	const { expectedRoot, actualRoot, ...compareOptions } = options;
	if ((expectedRoot === undefined) !== (actualRoot === undefined)) {
		throw new TypeError('expectedRoot and actualRoot must be given together');
	}
	return compareLegacyHttpSemanticSnapshots(
		legacyHttpSemanticSnapshot(expectedReport, { root: expectedRoot }),
		legacyHttpSemanticSnapshot(actualReport, { root: actualRoot }),
		compareOptions,
	);
}
