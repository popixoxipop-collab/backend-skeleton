// D-patch-transactions: the "config-apply" kind planner for lib/patch-transactions.mjs -- turns a
// catalog `config_check` entry's new, additive `apply` block into a real, comment-preserving edit
// via the `yaml` package's Document API (already a repo dependency, used elsewhere in this file's
// own sibling apply.mjs for read-only parsing). `propose`/`approve`/`apply` in bin/bskel.mjs all
// call planConfigApply() FRESH every time -- never trusting a stored render -- which is what makes
// "re-verify preimage at every step" real rather than assumed.
//
// Two things were verified live against yaml@2.9.0 before this module was written, not assumed:
// (1) doc.getIn(keyPath, true) and a mapping pair's key/value nodes carry real byte-offset
// `.range` tuples today -- the "preimage hash of the specific target region" primitive this
// feature needs. (2) the Document API does NOT byte-for-byte round-trip untouched lines elsewhere
// in the same file (comment spacing collapses, flow-collection spacing normalizes, trailing
// whitespace strips) -- a postcondition-only check would silently ship cosmetic reformatting of a
// hand-tuned config file, exactly the failure mode D-config-patch's own WHY was written to avoid.
// The collateral-diff check below is the direct fix for that, not an afterthought.
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, isScalar } from 'yaml';
import { sha256String } from '../lib/fsutil.mjs';
import { unifiedDiff } from '../lib/diff.mjs';
import { assertContained } from './apply.mjs';

class ConfigApplyPlanError extends Error {}

function findConfigCheck(entry, targetPath) {
	return (entry.static?.config_check ?? []).find((c) => c.target === targetPath);
}

// 0-indexed line number of a byte offset -- local, tiny, and 0-indexed (matching this module's own
// line-array comparisons below) rather than reusing scanners/text-util.mjs's 1-indexed
// lineNumberAt(), which would introduce a new stack/ -> scanners/ import direction for four lines
// of logic.
function lineIndexAt(text, offset) {
	let line = 0;
	for (let i = 0; i < offset; i++) if (text[i] === '\n') line++;
	return line;
}

// Refuses (throws ConfigApplyPlanError) unless EVERY line that differs between `before` and
// `after` falls within [targetStartLine, targetEndLine] (inclusive, 0-indexed) -- the direct
// mitigation for yaml's own confirmed collateral-reformatting behavior on UNTOUCHED lines
// elsewhere in the same document. A total line-count mismatch is refused outright (Slice 1 only
// ever targets a single-line scalar; a line appearing/disappearing anywhere is unexpected either
// way and safer to refuse than to reason about).
function assertNoCollateralChanges(relPath, before, after, targetStartLine, targetEndLine) {
	const beforeLines = before.split('\n');
	const afterLines = after.split('\n');
	if (beforeLines.length !== afterLines.length) {
		throw new ConfigApplyPlanError(
			`the proposed edit to "${relPath}" changes the file's total line count (${beforeLines.length} -> ${afterLines.length}), which this tool refuses to apply automatically -- review the diff and patch it by hand:\n${unifiedDiff(relPath, before, after)}`,
		);
	}
	const collateral = [];
	for (let i = 0; i < beforeLines.length; i++) {
		if (i >= targetStartLine && i <= targetEndLine) continue;
		if (beforeLines[i] !== afterLines[i]) collateral.push(i + 1);
	}
	if (collateral.length > 0) {
		throw new ConfigApplyPlanError(
			`the proposed edit to "${relPath}" would also change line(s) ${collateral.join(', ')} outside the target key -- refusing to risk silently reformatting unrelated content. Review the diff and patch it by hand:\n${unifiedDiff(relPath, before, after)}`,
		);
	}
}

// `catalogEntry` is an already-schema-validated stack/apply.mjs `loadCatalogEntry()` result;
// `targetPath` is the catalog-declared `config_check.target` (repo-relative) to act on. Returns a
// plan object shaped for lib/patch-transactions.mjs's propose/approve/apply, or throws
// ConfigApplyPlanError with a message safe to print directly to a human.
export function planConfigApply(repoRoot, catalogEntry, targetPath) {
	const check = findConfigCheck(catalogEntry, targetPath);
	if (!check) {
		throw new ConfigApplyPlanError(`no config_check entry for target "${targetPath}" in catalog choice "${catalogEntry.id}"`);
	}
	if (!check.apply) {
		throw new ConfigApplyPlanError(`no machine-applicable fix declared for "${targetPath}" in catalog choice "${catalogEntry.id}" -- see its note: "${check.note}"`);
	}

	const targetAbs = path.join(repoRoot, targetPath);
	assertContained(repoRoot, targetAbs, 'catalog config_check target path');
	if (!fs.existsSync(targetAbs)) {
		throw new ConfigApplyPlanError(`"${targetPath}" does not exist -- nothing to patch`);
	}
	const text = fs.readFileSync(targetAbs, 'utf8');

	const doc = parseDocument(text);
	const { key_path: keyPath, value_template: valueTemplate } = check.apply;
	const node = doc.getIn(keyPath, true);
	if (node === undefined) {
		throw new ConfigApplyPlanError(`"${targetPath}" has no value at ${JSON.stringify(keyPath)} -- the catalog entry's "apply.key_path" doesn't match this file's real structure`);
	}
	if (!isScalar(node)) {
		throw new ConfigApplyPlanError(`"${targetPath}"'s value at ${JSON.stringify(keyPath)} is not a plain scalar (it's a mapping or list) -- config_apply only ever targets a single scalar value`);
	}

	// The parent mapping's own pair for this key, so the region span can include the key AND its
	// trailing comment (pair.value.range[2]), not just the bare value -- a reformatted comment on
	// the TARGET's own line is expected (part of the edit), only OTHER lines' comments/spacing
	// changing is collateral damage.
	const parentPath = keyPath.slice(0, -1);
	const parentNode = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
	const lastKey = keyPath[keyPath.length - 1];
	const pair = parentNode.items.find((p) => String(p.key.value) === lastKey);
	if (!pair) {
		throw new ConfigApplyPlanError(`internal error: resolved a value at ${JSON.stringify(keyPath)} but could not locate its own key/value pair -- refusing`);
	}

	const currentValue = String(node.value);
	const proposedValue = valueTemplate.replaceAll('{{CURRENT}}', currentValue);

	const regionStart = pair.key.range[0];
	const regionEnd = pair.value.range[2];
	const regionText = text.slice(regionStart, regionEnd);
	const regionHash = sha256String(regionText);

	doc.setIn(keyPath, proposedValue);
	const renderedContent = String(doc);

	const targetStartLine = lineIndexAt(text, regionStart);
	// regionEnd (pair.value.range[2]) includes the target line's OWN trailing newline when the
	// value has a line comment or is the last token before one -- verified live against yaml@2.9.0.
	// Using regionEnd directly would make lineIndexAt count that newline as already passed, shifting
	// targetEndLine one line too far and silently exempting the FOLLOWING line from the collateral
	// check (confirmed live: without this -1, a flow-list reformatted on the very next line was
	// wrongly treated as "inside the target region" and the collateral check never fired).
	// Math.max guards the degenerate regionStart===regionEnd case (an empty span) from going negative.
	const targetEndLine = lineIndexAt(text, Math.max(regionStart, regionEnd - 1));
	assertNoCollateralChanges(targetPath, text, renderedContent, targetStartLine, targetEndLine);

	if (!new RegExp(check.externalized_pattern).test(renderedContent)) {
		throw new ConfigApplyPlanError(`the proposed edit to "${targetPath}" does not satisfy this catalog entry's own "externalized_pattern" -- the "apply" block is likely misconfigured, refusing rather than applying an edit that wouldn't even fix the check it's for`);
	}

	return {
		target: { file: targetPath, key_path: keyPath },
		preimage: { region_hash: regionHash, file_hash: sha256String(text) },
		current_value: currentValue,
		proposed_value: proposedValue,
		postcondition: { kind: 'regex-match', pattern: check.externalized_pattern },
		originalContent: text,
		renderedContent,
	};
}
