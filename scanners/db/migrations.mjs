// A4 (D-db-schema-plane): Plane A -- migration-file scanning, always local, never a network call.
// Deliberately NOT a real SQL parser -- same "good-enough regex, not a real parser" restraint as
// A2's Java analyzer and G2's Python analyzer, bounded to what real Flyway/Liquibase repos
// actually look like, not general SQL. Confirmed against the real oracle repo (Team-IZ-Backend)
// that it has ZERO migration files of either kind -- this module is unverifiable against it and
// is built/tested entirely against a synthetic fixture instead (see DECISIONS.md D-db-schema-plane).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function listRgFiles(repoRoot, glob) {
	try {
		return execFileSync('rg', ['--files', '-g', glob, repoRoot], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
	} catch {
		return []; // rg exits 1 on "no files matched" -- not an error
	}
}

// Same balanced-paren algorithm as python-fastapi.mjs's own local matchBalancedParens() and
// _java-spring-analyzer.mjs's matchBalanced() -- a third, deliberately separate copy, matching
// this project's own established precedent (see python-fastapi.mjs's own comment) of NOT reaching
// across an unrelated module boundary for a five-line algorithm; SQL is a different language from
// either of those, sharing the module would be a false economy.
function matchBalancedParens(text, openIndex) {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

// Splits a column-definition list on top-level commas only -- `VARCHAR(255)`/`NUMERIC(10,2)`/
// `CHECK (price > 0)` all carry their own parens that must not be mistaken for a column separator.
function splitTopLevelCommas(text) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')') depth = Math.max(0, depth - 1);
		else if (text[i] === ',' && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	const last = text.slice(start);
	if (last.trim()) parts.push(last);
	return parts.map((p) => p.trim()).filter(Boolean);
}

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(/gi;
const ALTER_ADD_COLUMN_RE = /ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
// A column definition line's own leading constraint keywords never name a column -- skips them so
// e.g. `PRIMARY KEY (id, org_id)` isn't mistaken for a column named "primary".
const CONSTRAINT_LEAD_RE = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;
const COLUMN_NAME_RE = /^"?(\w+)"?/;

function extractTablesFromSql(sqlText, sourceFile) {
	const tables = new Map(); // name -> Set<column>

	CREATE_TABLE_RE.lastIndex = 0;
	let m;
	while ((m = CREATE_TABLE_RE.exec(sqlText))) {
		const tableName = m[1];
		const openParen = m.index + m[0].length - 1;
		const closeParen = matchBalancedParens(sqlText, openParen);
		if (closeParen === -1) continue; // malformed -- skip, don't misattribute
		const body = sqlText.slice(openParen + 1, closeParen);
		const columns = new Set();
		for (const segment of splitTopLevelCommas(body)) {
			if (CONSTRAINT_LEAD_RE.test(segment)) continue;
			const colMatch = segment.match(COLUMN_NAME_RE);
			if (colMatch) columns.add(colMatch[1]);
		}
		if (!tables.has(tableName)) tables.set(tableName, new Set());
		for (const c of columns) tables.get(tableName).add(c);
	}

	ALTER_ADD_COLUMN_RE.lastIndex = 0;
	while ((m = ALTER_ADD_COLUMN_RE.exec(sqlText))) {
		const [, tableName, columnName] = m;
		if (!tables.has(tableName)) tables.set(tableName, new Set());
		tables.get(tableName).add(columnName);
	}

	return [...tables.entries()].map(([name, columns]) => ({ name, columns: [...columns].sort(), source_file: sourceFile }));
}

// Entry point. Returns `{ tool, files, tables }` -- `tool: 'none'` (empty files/tables) is a real,
// expected, and reported outcome, not an error -- most real repos (including the oracle repo
// itself) have no migration-file convention at all; their schema lives elsewhere (JPA ddl-auto,
// or -- the oracle repo's actual case -- entirely outside this repo, in an external Supabase
// project).
export function scanMigrations(repoRoot) {
	const flywayFiles = listRgFiles(repoRoot, '**/db/migration/**/*.sql');
	const liquibaseFiles = listRgFiles(repoRoot, '**/db/changelog/**/*.{xml,yaml,yml,sql}');

	if (flywayFiles.length === 0 && liquibaseFiles.length === 0) {
		return { tool: 'none', files: [], tables: [] };
	}

	if (flywayFiles.length > 0) {
		const tables = [];
		for (const file of flywayFiles) {
			const text = fs.readFileSync(file, 'utf8');
			tables.push(...extractTablesFromSql(text, path.relative(repoRoot, file)));
		}
		return { tool: 'flyway', files: flywayFiles.map((f) => path.relative(repoRoot, f)), tables };
	}

	// Liquibase changelogs are DETECTED (filenames recorded) but not deep-parsed in this first
	// pass -- XML/YAML changeSet parsing is a materially larger, separate job than Flyway's plain
	// SQL files; recording their presence is still real value over today's total silence, and is
	// an honestly documented gap, not a silent guess (see DECISIONS.md D-db-schema-plane).
	const sqlLiquibaseFiles = liquibaseFiles.filter((f) => f.endsWith('.sql'));
	const tables = [];
	for (const file of sqlLiquibaseFiles) {
		const text = fs.readFileSync(file, 'utf8');
		tables.push(...extractTablesFromSql(text, path.relative(repoRoot, file)));
	}
	return { tool: 'liquibase', files: liquibaseFiles.map((f) => path.relative(repoRoot, f)), tables };
}
