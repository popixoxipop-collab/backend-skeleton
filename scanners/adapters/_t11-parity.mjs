// T11-04 pre-freeze semantic parity harness.
//
// This module deliberately speaks only in the legacy HTTP adapters' already-observed vocabulary.
// It does not define T01/T02/T03's future normalized IR. A future next projection can earn parity
// by producing this snapshot shape, while the stable sbf.scan-report/2 remains the oracle during
// migration.
//
// The leading "_" keeps the file outside automatic adapter registration.

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

export function legacyHttpSemanticSnapshot(report) {
	if (!report || typeof report !== 'object' || report.schema !== 'sbf.scan-report/2') {
		throw new Error('legacy HTTP semantic snapshot requires sbf.scan-report/2');
	}
	return {
		schema: LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA,
		adapter: report.adapter ?? null,
		confidence: report.confidence ?? null,
		api_surface_source: report.api_surface_source ?? null,
		verdict: report.verdict ?? null,
		path_prefix_signals: JSON.parse(JSON.stringify(report.path_prefix_signals ?? [])),
		modules: (report.related_modules ?? []).map(plainModule),
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

export function compareLegacyHttpReports(expectedReport, actualReport, options) {
	return compareLegacyHttpSemanticSnapshots(
		legacyHttpSemanticSnapshot(expectedReport),
		legacyHttpSemanticSnapshot(actualReport),
		options,
	);
}
