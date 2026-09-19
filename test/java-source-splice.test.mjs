// D-java-source-splice: pure-function unit tests, no toolchain (no JDK/Gradle) required -- these
// exercise the parts of handles/providers/java-spring/source-splice.mjs that do not need the real
// AST helper or a real build. Real-toolchain coverage (the AST locate/compile round-trip, the
// decoy-overload defense, the auto-restore-on-compile-failure path) lives in
// scripts/java-compile-smoke.mjs and test/patch-java-splice-cli.test.mjs instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	JavaSplicePlanError,
	lineColToOffset,
	detectLineTerminator,
	independentFalsifierAgrees,
	deriveProloguePrefix,
	findImportsRegion,
	isDuplicateImport,
	computeMerkleRegionHash,
	assertNoOverlaps,
	applyEditsDescending,
	applyEditsAscending,
	assertOnlyRegionsChanged,
	requiredConfirmValue,
} from '../handles/providers/java-spring/source-splice.mjs';
import { maskNonCode } from '../scanners/adapters/_java-spring-analyzer.mjs';

// ---- lineColToOffset ----

test('lineColToOffset: line 1 col 1 is offset 0', () => {
	assert.equal(lineColToOffset('abc\ndef', 1, 1), 0);
});

test('lineColToOffset: finds the start of a later line correctly', () => {
	const text = 'line1\nline2\nline3';
	assert.equal(lineColToOffset(text, 2, 1), 6); // 'l' of "line2"
	assert.equal(lineColToOffset(text, 3, 3), 14); // 'n' of "line3"
});

test('lineColToOffset: throws for a line number beyond the file', () => {
	assert.throws(() => lineColToOffset('one\ntwo', 5, 1), JavaSplicePlanError);
});

// ---- detectLineTerminator ----

test('detectLineTerminator: LF file', () => {
	assert.equal(detectLineTerminator('a\nb\nc'), '\n');
});

test('detectLineTerminator: CRLF file', () => {
	assert.equal(detectLineTerminator('a\r\nb\r\nc'), '\r\n');
});

test('detectLineTerminator: no newline at all defaults to LF', () => {
	assert.equal(detectLineTerminator('no newlines here'), '\n');
});

// ---- independentFalsifierAgrees (D5, mechanism 3) ----

test('independentFalsifierAgrees: agrees when the region opens "{" right after the member name', () => {
	const src = 'class X {\n\tpublic void updateWidget() {\n\t\treturn;\n\t}\n}';
	const masked = maskNonCode(src);
	const braceIdx = src.indexOf('{', src.indexOf('updateWidget'));
	assert.equal(independentFalsifierAgrees(masked, 'updateWidget', braceIdx, 'method'), true);
});

test('independentFalsifierAgrees: disagrees when the region does not open with "{"', () => {
	const src = 'class X {\n\tint retries = 3;\n}';
	const masked = maskNonCode(src);
	const wrongOffset = src.indexOf('retries'); // not a '{'
	assert.equal(independentFalsifierAgrees(masked, 'retries', wrongOffset, 'method'), false);
});

test('independentFalsifierAgrees: disagrees when the member name does not appear nearby', () => {
	const src = 'class X {\n\tpublic void otherMethod() {\n\t\treturn;\n\t}\n}';
	const masked = maskNonCode(src);
	const braceIdx = src.indexOf('{', src.indexOf('otherMethod'));
	assert.equal(independentFalsifierAgrees(masked, 'updateWidget', braceIdx, 'method'), false);
});

test('independentFalsifierAgrees: a member name only appearing inside a string/comment does not count (masked)', () => {
	const src = 'class X {\n\t// calls updateWidget elsewhere\n\tpublic void other() {\n\t\treturn;\n\t}\n}';
	const masked = maskNonCode(src);
	const braceIdx = src.indexOf('{', src.indexOf('public void other'));
	assert.equal(independentFalsifierAgrees(masked, 'updateWidget', braceIdx, 'method'), false);
});

// ---- deriveProloguePrefix ----

test('deriveProloguePrefix: prepends statements and preserves the original body verbatim as a suffix', () => {
	const original = '{\n\t\treturn x;\n\t}';
	const result = deriveProloguePrefix(original, 'log.info("start");', '\n');
	assert.ok(result.endsWith(original.slice(1)), 'must end with the original body minus its own leading "{"');
	assert.ok(result.startsWith('{\n'));
	assert.ok(result.includes('log.info("start");'));
});

test('deriveProloguePrefix: copies indentation from the first non-blank line', () => {
	const original = '{\n\t\treturn x;\n\t}';
	const result = deriveProloguePrefix(original, 'STATEMENT();', '\n');
	const lines = result.split('\n');
	assert.equal(lines[1], '\t\tSTATEMENT();');
});

test('deriveProloguePrefix: refuses an empty body', () => {
	assert.throws(() => deriveProloguePrefix('{}', 'x();', '\n'), JavaSplicePlanError);
	assert.throws(() => deriveProloguePrefix('{ }', 'x();', '\n'), JavaSplicePlanError);
	assert.throws(() => deriveProloguePrefix('{\n\n}', 'x();', '\n'), JavaSplicePlanError);
});

// ---- findImportsRegion / isDuplicateImport ----

test('findImportsRegion: covers package + every import, stops at the type declaration', () => {
	const src = 'package com.example;\n\nimport java.util.UUID;\nimport java.util.List;\n\npublic class X {\n}';
	const region = findImportsRegion(src);
	const text = src.slice(region.start, region.end);
	assert.ok(text.includes('package com.example;'));
	assert.ok(text.includes('import java.util.UUID;'));
	assert.ok(text.includes('import java.util.List;'));
	assert.ok(!text.includes('class X'));
});

test('findImportsRegion: zero-existing-imports path -- region ends right after the package statement', () => {
	const src = 'package com.example;\n\npublic class X {\n}';
	const region = findImportsRegion(src);
	const text = src.slice(region.start, region.end);
	assert.equal(text, 'package com.example;');
});

test('findImportsRegion: default package (no package statement) -- region starts and can end at offset 0', () => {
	const src = 'public class X {\n}';
	const region = findImportsRegion(src);
	assert.equal(region.start, 0);
	assert.equal(region.end, 0);
});

test('isDuplicateImport: detects an exact existing import', () => {
	const src = 'package p;\nimport java.util.UUID;\nclass X {}';
	assert.equal(isDuplicateImport(src, 'java.util.UUID'), true);
	assert.equal(isDuplicateImport(src, 'java.util.List'), false);
});

// ---- computeMerkleRegionHash ----

test('computeMerkleRegionHash: is stable for the same input', () => {
	const edits = [
		{ op: 'replace-method-body', locator: { type_fqn: 'X', member_kind: 'method', member_name: 'f' }, region_hash: 'aaa', signature_hash: 'bbb' },
	];
	assert.equal(computeMerkleRegionHash(edits), computeMerkleRegionHash(JSON.parse(JSON.stringify(edits))));
});

test('computeMerkleRegionHash: order-sensitive -- swapping two edits changes the hash', () => {
	const a = { op: 'replace-method-body', locator: { type_fqn: 'X', member_kind: 'method', member_name: 'f' }, region_hash: 'aaa', signature_hash: 'bbb' };
	const b = { op: 'add-import', region_hash: 'ccc', signature_hash: null };
	assert.notEqual(computeMerkleRegionHash([a, b]), computeMerkleRegionHash([b, a]));
});

test('computeMerkleRegionHash: changing any one edit\'s region_hash changes the overall hash', () => {
	const edits = [{ op: 'replace-field-initializer', locator: { type_fqn: 'X', member_kind: 'field', member_name: 'f' }, region_hash: 'aaa', signature_hash: 'bbb' }];
	const mutated = [{ ...edits[0], region_hash: 'different' }];
	assert.notEqual(computeMerkleRegionHash(edits), computeMerkleRegionHash(mutated));
});

// ---- assertNoOverlaps ----

test('assertNoOverlaps: passes for non-overlapping ranges', () => {
	assert.doesNotThrow(() => assertNoOverlaps([{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 25, end: 30 }], 'X.java'));
});

test('assertNoOverlaps: throws for overlapping ranges, regardless of input order', () => {
	assert.throws(() => assertNoOverlaps([{ start: 5, end: 15 }, { start: 0, end: 10 }], 'X.java'), JavaSplicePlanError);
});

// ---- applyEditsDescending / applyEditsAscending / assertOnlyRegionsChanged ----

function makeEdit(start, end, replacement) {
	return { _start: start, _end: end, _finalReplacement: replacement };
}

test('applyEditsDescending and applyEditsAscending agree for three non-overlapping, non-adjacent edits', () => {
	const text = '0123456789';
	const edits = [makeEdit(1, 2, 'X'), makeEdit(4, 5, 'Y'), makeEdit(7, 8, 'Z')];
	const descending = applyEditsDescending(text, edits);
	const ascending = applyEditsAscending(text, edits);
	assert.equal(descending, ascending);
	assert.equal(descending, '0X23Y56Z89');
});

test('applyEditsDescending and applyEditsAscending agree for three adjacent (touching, non-overlapping) edits', () => {
	const text = '0123456789';
	const edits = [makeEdit(0, 3, 'AAA'), makeEdit(3, 6, 'BBB'), makeEdit(6, 9, 'CCC')];
	const descending = applyEditsDescending(text, edits);
	const ascending = applyEditsAscending(text, edits);
	assert.equal(descending, ascending);
	assert.equal(descending, 'AAABBBCCC9');
});

test('applyEditsDescending: add-import-shaped edit (lowest start offset) is applied last, unaffected by later-in-file edits', () => {
	const text = 'package p;\nimport a.b;\n\nclass X { void f() { return 1; } }';
	const importEnd = text.indexOf('import a.b;') + 'import a.b;'.length;
	const bodyStart = text.indexOf('{', text.indexOf('void f'));
	const bodyEnd = text.length - 1; // the final '}'
	const edits = [
		makeEdit(0, importEnd, `${text.slice(0, importEnd)}\nimport c.d;`),
		makeEdit(bodyStart, bodyEnd + 1, '{ return 2; }'),
	];
	const rendered = applyEditsDescending(text, edits);
	assert.ok(rendered.includes('import c.d;'));
	assert.ok(rendered.includes('return 2;'));
});

test('assertOnlyRegionsChanged: returns the spliced text when both constructions agree', () => {
	const text = 'abcdefgh';
	const edits = [makeEdit(2, 4, 'XY')];
	assert.equal(assertOnlyRegionsChanged(text, edits), 'abXYefgh');
});

// ---- requiredConfirmValue ----

test('requiredConfirmValue: a destructive edit requires retyping "Type#member", sorted and deduped', () => {
	const txn = {
		transaction_id: 'pt-abc',
		target: {
			edits: [
				{ op: 'replace-method-body', locator: { type_fqn: 'com.example.WidgetServiceImpl', member_kind: 'method', member_name: 'updateWidget' } },
				{ op: 'replace-field-initializer', locator: { type_fqn: 'com.example.WidgetServiceImpl', member_kind: 'field', member_name: 'retries' } },
			],
		},
	};
	assert.equal(requiredConfirmValue(txn), 'WidgetServiceImpl#retries,WidgetServiceImpl#updateWidget');
});

test('requiredConfirmValue: an add-import-only transaction falls back to the transaction id', () => {
	const txn = { transaction_id: 'pt-xyz', target: { edits: [{ op: 'add-import', imports: ['java.util.UUID'] }] } };
	assert.equal(requiredConfirmValue(txn), 'pt-xyz');
});
