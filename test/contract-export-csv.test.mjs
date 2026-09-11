// D-contract-csv: unit tests for contracts/csv.mjs -- pure functions, hand-built contract
// objects matching schemas/feature-contract.schema.json's real operation shape (confirmed by
// direct read of that schema and contracts/emit.mjs before writing this file). CLI-level tests
// (gate-independence, --out/--json/stdout shapes, refusals) live in
// test/contract-export-csv-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_COLUMNS, escapeCsvField, toCsv, buildContractCsv } from '../contracts/csv.mjs';

function op(overrides = {}) {
	return { verb: 'GET', path: '/widgets/{id}', pathParams: { properties: { id: { type: 'string' } } }, body: false, provenance: 'scan', ...overrides };
}

// A minimal RFC 4180 line splitter -- several columns under test legitimately contain commas
// (e.g. "id, orgId"), so a naive `line.split(',')` misaligns every column after the first quoted
// one. This is test-only infrastructure, deliberately NOT imported from contracts/csv.mjs (which
// has no need to ever parse its own output back).
function splitCsvLine(line) {
	const fields = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
			else if (ch === '"') { inQuotes = false; }
			else { field += ch; }
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			fields.push(field);
			field = '';
		} else {
			field += ch;
		}
	}
	fields.push(field);
	return fields;
}

function rowFor(contract, operationId) {
	const result = buildContractCsv({ contract });
	const lines = result.csv.trim().split('\n');
	const idx = lines.slice(1).findIndex((line) => splitCsvLine(line)[0] === operationId) + 1;
	return { result, fields: splitCsvLine(lines[idx]) };
}

function colIndex(name) {
	return CSV_COLUMNS.findIndex((c) => c.name === name);
}

// ---- escapeCsvField / toCsv (RFC 4180, C4) ------------------------------------------------

test('escapeCsvField: a plain value is never quoted (the negative case that catches over-eager escaping)', () => {
	assert.equal(escapeCsvField('plain'), 'plain');
	assert.equal(escapeCsvField(''), '');
});

test('escapeCsvField: a comma triggers quoting', () => {
	assert.equal(escapeCsvField('a,b'), '"a,b"');
});

test('escapeCsvField: a double quote triggers quoting AND is doubled', () => {
	assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
});

test('escapeCsvField: a newline (LF or CR) triggers quoting', () => {
	assert.equal(escapeCsvField('a\nb'), '"a\nb"');
	assert.equal(escapeCsvField('a\rb'), '"a\rb"');
});

test('escapeCsvField: comma + quote + newline together are still correctly escaped in one pass', () => {
	assert.equal(escapeCsvField('a,"b"\nc'), '"a,""b""\nc"');
});

test('escapeCsvField: a value with no special characters is not quoted, even if it contains other punctuation', () => {
	assert.equal(escapeCsvField('(source-declared: none)'), '(source-declared: none)');
});

test('toCsv: LF-terminated, no preamble -- line 1 is the header row', () => {
	const csv = toCsv(['a', 'b'], [['1', '2']]);
	assert.equal(csv, 'a,b\n1,2\n');
	assert.equal(csv.includes('\r'), false);
});

// ---- buildContractCsv: header shape (C2) ---------------------------------------------------

test('buildContractCsv: the fixed 14-column header is identical for a scan-only and a scan+openapi contract', () => {
	const scanOnly = { operations: { getWidget: op() } };
	const withOpenapi = { operations: { getWidget: op({ provenance: 'scan+openapi', sourceSummary: 'Get a widget', sourceTags: ['widgets'] }) } };
	const a = buildContractCsv({ contract: scanOnly });
	const b = buildContractCsv({ contract: withOpenapi });
	const headerA = a.csv.split('\n')[0];
	const headerB = b.csv.split('\n')[0];
	assert.equal(headerA, headerB);
	const headerFields = splitCsvLine(headerA);
	assert.equal(headerFields.length, 14);
	assert.deepEqual(headerFields, CSV_COLUMNS.map((c) => c.name));
});

test('buildContractCsv: a scan-only contract leaves summary/tags/security blank, and reports them as emptyColumns (C2)', () => {
	// Every column OTHER than summary/tags/security is deliberately populated here, so this test
	// isolates exactly the fields a scan-only contract (no --openapi-file) never states -- the
	// three source-document passthrough fields -- rather than every field this minimal fixture
	// happens not to set.
	const richOp = (overrides) => op({
		requestBodyRequired: true,
		requestBodySchema: { properties: { id: {} } },
		responseSchema: { properties: { id: {} } },
		errorSchema: { properties: { message: {} } },
		pathParamsHeuristic: ['id'],
		...overrides,
	});
	const result = buildContractCsv({ contract: { operations: { getWidget: richOp(), listWidgets: richOp({ path: '/widgets' }) } } });
	assert.equal(result.ok, true);
	assert.deepEqual(result.emptyColumns.sort(), ['security', 'summary', 'tags'].sort());
	const summaryCol = result.columns.find((c) => c.name === 'summary');
	assert.equal(summaryCol.populatedRows, 0);
});

test('buildContractCsv: zero operations refuses with ok:false, not an empty CSV', () => {
	const result = buildContractCsv({ contract: { operations: {} } });
	assert.equal(result.ok, false);
	assert.match(result.error, /zero operations/);
});

// ---- per-column extraction -----------------------------------------------------------------

test('buildContractCsv: operation_id comes from the map KEY, not a field inside the operation value', () => {
	const { fields } = rowFor({ operations: { deleteWidget: op({ verb: 'DELETE', path: '/widgets/{id}' }) } }, 'deleteWidget');
	assert.equal(fields[0], 'deleteWidget');
});

test('buildContractCsv: path_params lists sorted properties of pathParams.properties, comma-joined', () => {
	const { fields } = rowFor({ operations: { x: op({ pathParams: { properties: { orgId: {}, id: {} } } }) } }, 'x');
	assert.equal(fields[colIndex('path_params')], 'id, orgId');
});

test('buildContractCsv: path_params_unverified reflects pathParamsHeuristic, empty when absent', () => {
	const r1 = rowFor({ operations: { a: op({ pathParamsHeuristic: ['orgId'] }) } }, 'a');
	const r2 = rowFor({ operations: { a: op({ pathParamsHeuristic: null }) } }, 'a');
	assert.equal(r1.fields[colIndex('path_params_unverified')], 'orgId');
	assert.equal(r2.fields[colIndex('path_params_unverified')], '');
});

test('buildContractCsv: request_body_required renders "" when absent, "true"/"false" when present (never coerced to a truthy blank)', () => {
	for (const [overrides, expected] of [[{}, ''], [{ requestBodyRequired: true }, 'true'], [{ requestBodyRequired: false }, 'false']]) {
		const { fields } = rowFor({ operations: { a: op(overrides) } }, 'a');
		assert.equal(fields[colIndex('request_body_required')], expected);
	}
});

test('buildContractCsv: request/response/error _fields are sorted top-level property keys only, never recursed', () => {
	const withSchemas = op({
		requestBodySchema: { type: 'object', properties: { zeta: {}, alpha: { properties: { nested: {} } } } },
		responseSchema: { type: 'object', properties: { id: {} } },
		errorSchema: { anyOf: [{ properties: { code: {} } }] }, // union shape -- no top-level .properties, must render blank
	});
	const { fields } = rowFor({ operations: { a: withSchemas } }, 'a');
	assert.equal(fields[colIndex('request_body_fields')], 'alpha, zeta');
	assert.equal(fields[colIndex('response_fields')], 'id');
	// anyOf union has no top-level .properties -- must render blank, never fabricated from nested shapes.
	assert.equal(fields[colIndex('error_fields')], '');
});

// ---- security sentinel (distinguishing [] from absent) --------------------------------------

test('buildContractCsv: sourceSecurity=[] (a genuine "no auth" claim) renders (source-declared: none); absent renders empty', () => {
	const r1 = rowFor({ operations: { a: op({ sourceSecurity: [] }) } }, 'a');
	const r2 = rowFor({ operations: { a: op() } }, 'a');
	const r3 = rowFor({ operations: { a: op({ sourceSecurity: [{ bearerAuth: [] }] }) } }, 'a');
	assert.equal(r1.fields[colIndex('security')], '(source-declared: none)');
	assert.equal(r2.fields[colIndex('security')], '');
	assert.equal(r3.fields[colIndex('security')], 'bearerAuth');
});

test('buildContractCsv: security lists every distinct scheme name across multiple requirement alternatives, deduped and sorted', () => {
	const { fields } = rowFor({ operations: { a: op({ sourceSecurity: [{ apiKey: [] }, { bearerAuth: [], apiKey: [] }] }) } }, 'a');
	assert.equal(fields[colIndex('security')], 'apiKey, bearerAuth');
});

// ---- row order and byte-stability -----------------------------------------------------------

test('buildContractCsv: rows are ordered by operation_id (localeCompare), stable across calls', () => {
	const contract = { operations: { zebra: op(), alpha: op(), mango: op() } };
	const r1 = buildContractCsv({ contract });
	const r2 = buildContractCsv({ contract });
	assert.equal(r1.csv, r2.csv);
	const ids = r1.csv.trim().split('\n').slice(1).map((line) => splitCsvLine(line)[0]);
	assert.deepEqual(ids, ['alpha', 'mango', 'zebra']);
});

test('buildContractCsv: non-ASCII (Korean) summary survives unmangled', () => {
	const result = buildContractCsv({ contract: { operations: { a: op({ sourceSummary: '위젯을 조회합니다' }) } } });
	assert.match(result.csv, /위젯을 조회합니다/);
});
