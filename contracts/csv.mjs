// D-contract-csv: a spreadsheet-shaped projection of a feature contract -- one row per operation,
// opened by someone who will never read a JSON Schema. Pure module, no I/O, no gate awareness, no
// process -- mirrors contracts/export.mjs's own contract (see that file's header comment) exactly,
// so this file can be unit-tested with hand-built `contract` objects and nothing else.
//
// C1: a fixed 14-column header, always -- see C2 in DECISIONS.md for why a column is never
// dropped just because every operation leaves it blank (a scan-only contract's `summary`/`tags`/
// `security` columns ARE the finding "nobody stated these", not something to hide by omitting the
// column). C3: `description` is deliberately NOT a column (measured average 2,442.7 bytes/op,
// larger than every other copied field combined -- see D-openapi-description).
export const CSV_COLUMNS = Object.freeze([
	{ name: 'operation_id', extract: (op, operationId) => operationId },
	{ name: 'verb', extract: (op) => op.verb },
	{ name: 'path', extract: (op) => op.path },
	{ name: 'path_params', extract: (op) => sortedKeys(op.pathParams?.properties).join(', ') },
	{ name: 'path_params_unverified', extract: (op) => (op.pathParamsHeuristic ?? []).join(', ') },
	{ name: 'body', extract: (op) => String(op.body) },
	{ name: 'request_body_required', extract: (op) => (op.requestBodyRequired == null ? '' : String(op.requestBodyRequired)) },
	{ name: 'request_body_fields', extract: (op) => sortedKeys(op.requestBodySchema?.properties).join(', ') },
	{ name: 'response_fields', extract: (op) => sortedKeys(op.responseSchema?.properties).join(', ') },
	{ name: 'error_fields', extract: (op) => sortedKeys(op.errorSchema?.properties).join(', ') },
	{ name: 'provenance', extract: (op) => op.provenance },
	{ name: 'summary', extract: (op) => op.sourceSummary ?? '' },
	{ name: 'tags', extract: (op) => (op.sourceTags ?? []).join(', ') },
	{ name: 'security', extract: (op) => extractSecurity(op.sourceSecurity) },
]);

function sortedKeys(properties) {
	return properties ? Object.keys(properties).sort() : [];
}

// `security: []` is a genuine positive claim ("this operation declared no auth requirement") --
// see schemas/feature-contract.schema.json's own sourceSecurity description. An ABSENT
// sourceSecurity means the source document said nothing about security for this operation at all.
// The two must render distinguishably, or a reviewer cannot tell "confirmed open" from "unknown".
function extractSecurity(sourceSecurity) {
	if (sourceSecurity == null) return '';
	if (sourceSecurity.length === 0) return '(source-declared: none)';
	const schemeNames = new Set();
	for (const requirement of sourceSecurity) {
		for (const scheme of Object.keys(requirement)) schemeNames.add(scheme);
	}
	return [...schemeNames].sort().join(', ');
}

// C4: RFC 4180, hand-rolled -- quote a field iff it contains a double quote, comma, CR, or LF;
// an embedded double quote is escaped by doubling it. Deliberately does NOT quote a field that
// needs none of this (the negative case is what catches an over-eager escaper in tests). No new
// dependency: this is the entire rule CSV has needed since RFC 4180 (2005).
export function escapeCsvField(value) {
	const str = String(value);
	if (/["\n\r,]/.test(str)) {
		return `"${str.replaceAll('"', '""')}"`;
	}
	return str;
}

// C4: LF line terminator (not RFC 4180's CRLF) -- every other artifact this project writes is
// LF, and these files get committed/diffed. No comment/provenance preamble: line 1 is always the
// header row, because a leading `#`/comment line breaks `pandas.read_csv`/`csv.DictReader`/every
// spreadsheet importer's default settings -- provenance goes to stderr/`--json`, never into the
// file itself.
export function toCsv(header, rows) {
	const lines = [header, ...rows].map((row) => row.map(escapeCsvField).join(','));
	return `${lines.join('\n')}\n`;
}

// C5: deliberately does NOT check gate state, does NOT read a scan report, does NOT look at
// path-prefix signals -- this is a pure projection of an already-loaded `contract` object. The
// caller (bin/bskel.mjs's cmdContractExportCsv) owns every refusal/warning decision; this
// function only ever succeeds or reports "there's nothing to export" for a genuinely empty
// contract.
export function buildContractCsv({ contract }) {
	const operationIds = Object.keys(contract.operations).sort((a, b) => a.localeCompare(b));
	if (operationIds.length === 0) {
		return { ok: false, error: 'contract has zero operations' };
	}

	const header = CSV_COLUMNS.map((c) => c.name);
	const rows = operationIds.map((operationId) => {
		const op = contract.operations[operationId];
		return CSV_COLUMNS.map((c) => c.extract(op, operationId));
	});

	// C2: coverage is reported alongside the file, never inferred by a reader staring at blank
	// cells wondering whether the tool is broken.
	const columns = CSV_COLUMNS.map((c, i) => ({
		name: c.name,
		populatedRows: rows.filter((row) => row[i] !== '').length,
	}));
	const emptyColumns = columns.filter((c) => c.populatedRows === 0).map((c) => c.name);

	return {
		ok: true,
		csv: toCsv(header, rows),
		rowCount: rows.length,
		columns,
		emptyColumns,
	};
}
