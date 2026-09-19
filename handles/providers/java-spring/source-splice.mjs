// D-java-source-splice: the "java-source-splice" kind for lib/patch-transactions.mjs -- in-file
// editing of real, hand-written Java source (a method body, a field initializer, or one new
// import), closing D-patch-transactions' own first-named EXIT item ("in-file source splicing").
//
// Node identity (Codex's own named central risk for this class of feature -- "incorrect node
// identity is the central risk") is established by THREE independent mechanisms, not one:
//   1. the real JavaParser+Symbol Solver AST helper (ast-bridge.mjs's runAstLocate), which
//      resolves a member by its language-guaranteed identity: a type's fully-qualified name plus,
//      for a method, its ERASED parameter types -- the exact rule javac itself uses to forbid two
//      same-named methods sharing the same erased signature. This is authoritative.
//   2. a self-validating offset conversion: the AST reports 1-based line/column, this module
//      converts to a byte offset itself and asserts `text.slice(start,end) === regionText`
//      exactly -- an offset-math bug fails CLOSED (refuses) rather than silently mis-splicing.
//   3. an INDEPENDENT falsifier using scanners/adapters/_java-spring-analyzer.mjs's maskNonCode()
//      -- confirms the located region genuinely opens with '{' and that the member's own name
//      appears immediately before it, on masked (comment/string-safe) text. This exists because a
//      first draft that used ONLY the regex-based analyzer as the *locator* was proven live (see
//      DECISIONS.md D-java-source-splice) to pick the WRONG overload -- that toolkit is kept here
//      only as a second opinion, never as the source of truth.
//
// Mirrors stack/config-apply.mjs's/scanners/db/ddl-apply.mjs's planner contract exactly (the same
// seven plan fields), and reuses lib/attest.mjs-established discipline nowhere directly (this
// kind has no attestation involvement) but the SAME "never trust a stored computation, always
// re-derive" posture those items established for this codebase generally.
import fs from 'node:fs';
import path from 'node:path';
import { sha256String, sha256File } from '../../../lib/fsutil.mjs';
import { unifiedDiff } from '../../../lib/diff.mjs';
import { assertContained } from '../../../stack/apply.mjs';
import { detectAstHelperAvailable, runAstLocate, runAstParse } from './ast-bridge.mjs';
import { maskNonCode, matchBalanced } from '../../../scanners/adapters/_java-spring-analyzer.mjs';
import { detectJavaSpringRoot } from '../../../scanners/adapters/java-spring.mjs';
import { loadManifest, BSKEL_GENERATED_MARKER } from '../../../lib/handles-manifest.mjs';
import { detectBuildCommand, runBuildCheck } from '../../../lib/verify.mjs';
import { readBlob } from '../../../lib/patch-transactions.mjs';

export class JavaSplicePlanError extends Error {}
export class JavaSpliceExecutionError extends Error {}

const DESTRUCTIVE_OPS = new Set(['replace-method-body', 'insert-method-body-prologue', 'replace-field-initializer']);
const SUPPORTED_OPS = new Set([...DESTRUCTIVE_OPS, 'add-import']);

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

// 1-based line, 1-based column (JavaParser's own convention, confirmed live) -> 0-based string
// index. Never trusted on its own -- every caller immediately asserts the resulting slice equals
// the AST's own reported text (D5, mechanism 2).
export function lineColToOffset(text, line, col) {
	let idx = 0;
	let currentLine = 1;
	while (currentLine < line) {
		const nl = text.indexOf('\n', idx);
		if (nl === -1) throw new JavaSplicePlanError(`internal error: line ${line} exceeds the file's actual line count`);
		idx = nl + 1;
		currentLine++;
	}
	return idx + (col - 1);
}

export function detectLineTerminator(text) {
	const idx = text.indexOf('\n');
	if (idx === -1) return '\n';
	return text[idx - 1] === '\r' ? '\r\n' : '\n';
}

// D5, mechanism 3: an INDEPENDENT (non-AST) falsifier -- confirms the region genuinely opens a
// method body immediately after the member's own name, on masked (string/comment-safe) text, so
// a wrong-nesting-level AST result cannot silently pass. Deliberately narrow -- it is a second
// opinion, not a second locator.
export function independentFalsifierAgrees(maskedText, memberName, regionStartOffset, kind) {
	if (kind === 'method' && maskedText[regionStartOffset] !== '{') return false;
	const windowStart = Math.max(0, regionStartOffset - 400);
	const window = maskedText.slice(windowStart, regionStartOffset);
	const nameRe = new RegExp(`\\b${memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
	return nameRe.test(window);
}

// D2: `insert-method-body-prologue`'s replacement is DERIVED, never supplied -- the original
// body's remainder (everything after its own leading "{") must survive as a verbatim suffix.
export function deriveProloguePrefix(originalRegionText, statements, terminator) {
	if (originalRegionText === '{}' || originalRegionText.replace(/[{}\s]/g, '') === '') {
		throw new JavaSplicePlanError('insert-method-body-prologue refuses an empty method body ("{}") -- there is no existing indentation to infer; use replace-method-body instead');
	}
	const lines = originalRegionText.split(terminator);
	// lines[0] is "{" itself; the first non-blank line after it carries the indent to copy.
	const indentLine = lines.slice(1).find((l) => l.trim().length > 0);
	if (indentLine === undefined) {
		throw new JavaSplicePlanError('insert-method-body-prologue could not find an indentation reference line in the existing body -- use replace-method-body instead');
	}
	const indent = indentLine.slice(0, indentLine.length - indentLine.trimStart().length);
	const remainder = originalRegionText.slice(1); // drop only the leading "{"
	const replacement = `{${terminator}${indent}${statements}${terminator}${remainder}`;
	if (!replacement.endsWith(remainder)) {
		throw new JavaSplicePlanError('internal error: insert-method-body-prologue built a replacement that does not end with the original body verbatim');
	}
	return replacement;
}

// D2 (add-import): the file's own "package ...; \n import ...; \n import ...;" prefix, found by
// plain text scanning (this edit has no per-member locator -- it targets the file's own import
// block, not a class member, so the AST "locate" mechanism does not apply to it). Handles the
// zero-existing-imports case (region ends right after the package statement, or at offset 0 for a
// default-package file).
export function findImportsRegion(text) {
	const pkgMatch = text.match(/^\s*package\s+[\w.]+\s*;/m);
	let end = pkgMatch ? pkgMatch.index + pkgMatch[0].length : 0;
	const importRe = /^\s*import\s+(?:static\s+)?[\w.]+(?:\.\*)?\s*;/gm;
	importRe.lastIndex = end;
	let m;
	let lastImportEnd = end;
	while ((m = importRe.exec(text)) !== null) {
		// Only count imports that are reasonably contiguous with what's already been scanned
		// (allow blank lines/comments between them, but stop once we've clearly left the import
		// block -- e.g. reached a type declaration). A simple, generous heuristic: keep advancing
		// as long as nothing but whitespace/comments/imports appears between the previous end and
		// this match.
		const between = text.slice(lastImportEnd, m.index);
		if (/\b(class|interface|enum|record|@interface)\b/.test(between)) break;
		lastImportEnd = m.index + m[0].length;
	}
	return { start: 0, end: lastImportEnd };
}

export function isDuplicateImport(text, fqn) {
	const re = new RegExp(`^\\s*import\\s+${fqn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*;`, 'm');
	return re.test(text);
}

// D3: the Merkle roll-up -- a single hash covering every edit's own (op, locator, region_hash,
// signature_hash), fed into the ENGINE's one `preimage.region_hash` field so N edits are covered
// by the transaction engine's existing single-field TOCTOU check with zero engine change.
// `edits` here are the already-enriched {op, locator, region_hash, signature_hash} records (in
// the SAME order they were declared in the request document -- order-sensitive by design, so
// re-ordering two edits in a re-plan is itself detected as drift).
export function computeMerkleRegionHash(edits) {
	return sha256String(JSON.stringify(
		edits.map((e) => [e.op, e.locator ?? null, e.region_hash, e.signature_hash ?? null]),
	));
}

// Rung 13: throws JavaSplicePlanError naming the file if any two [start,end) ranges overlap.
// `ranges` need not be pre-sorted.
export function assertNoOverlaps(ranges, file) {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].start < sorted[i - 1].end) {
			throw new JavaSplicePlanError(`two edits target overlapping regions of "${file}" -- refusing`);
		}
	}
}

// Applies `edits` (each carrying `_start`/`_end`/`_finalReplacement`) to `text` from the END of
// the file backward (highest start offset first) -- every earlier (lower-start) edit's own
// offsets stay valid throughout, since nothing before the current edit's start has been touched
// yet. `add-import`'s region always starts at/near offset 0, so it is always applied LAST here.
export function applyEditsDescending(text, edits) {
	const descending = [...edits].sort((a, b) => b._start - a._start);
	let rendered = text;
	for (const e of descending) {
		rendered = rendered.slice(0, e._start) + e._finalReplacement + rendered.slice(e._end);
	}
	return rendered;
}

// The SAME splice, built the opposite direction (lowest start offset first, single forward pass)
// -- an independent second construction, not a refactor of the first. Asserted equal to
// applyEditsDescending()'s own result by the caller (assertOnlyRegionsChanged's actual mechanism)
// so an off-by-one in EITHER loop is caught, not just a stray change outside the touched regions.
export function applyEditsAscending(text, edits) {
	const ascending = [...edits].sort((a, b) => a._start - b._start);
	let result = '';
	let cursor = 0;
	for (const e of ascending) {
		result += text.slice(cursor, e._start) + e._finalReplacement;
		cursor = e._end;
	}
	result += text.slice(cursor);
	return result;
}

// D4's defensive assertion, named for what it proves: the only bytes that differ between
// `original` and `rendered` are inside the edits' own regions. Implemented by cross-checking two
// INDEPENDENTLY-constructed renders (forward vs backward splice) rather than diffing remainders --
// strictly stronger, since it also catches an off-by-one inside either construction itself, not
// only a stray change outside every touched region. Should be unreachable; throws if it isn't.
export function assertOnlyRegionsChanged(text, edits) {
	const descending = applyEditsDescending(text, edits);
	const ascending = applyEditsAscending(text, edits);
	if (descending !== ascending) {
		throw new JavaSplicePlanError('internal error: forward and backward edit application produced different results -- refusing rather than risk a corrupted splice (this should be unreachable; please report it)');
	}
	return descending;
}

// ---------------------------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------------------------

// `params` = { file (repo-relative), edits (the --splice-file document's own `edits[]`, already
// schema-validated by the caller at propose time -- re-plan at approve/apply reconstructs this
// same shape from the stored transaction's target.edits, see paramsFromTxn() in lib/patch-kinds.mjs) }.
export async function planJavaSourceSplice(repoRoot, { file, edits }) {
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new JavaSplicePlanError('java-source-splice requires at least one edit');
	}
	for (const e of edits) {
		if (!SUPPORTED_OPS.has(e.op)) {
			throw new JavaSplicePlanError(`unsupported op "${e.op}" -- java-source-splice only supports: ${[...SUPPORTED_OPS].join(', ')}`);
		}
	}
	const addImportEdits = edits.filter((e) => e.op === 'add-import');
	if (addImportEdits.length > 1) {
		throw new JavaSplicePlanError('at most one add-import edit is permitted per transaction (each would target the same file-prefix region, so a second one would overlap the first)');
	}

	const targetAbs = path.join(repoRoot, file);
	assertContained(repoRoot, targetAbs, 'java-source-splice target file');
	if (!file.endsWith('.java')) {
		throw new JavaSplicePlanError(`"${file}" is not a .java file`);
	}
	if (!fs.existsSync(targetAbs)) {
		throw new JavaSplicePlanError(`"${file}" does not exist -- nothing to splice`);
	}

	const text = fs.readFileSync(targetAbs, 'utf8');

	// Rung: bskel-generated files are off-limits -- a later `handles emit` would silently
	// overwrite a hand-spliced edit; the real fix is to edit the template or the resolver-
	// ownership path instead, not to splice generated output.
	const manifest = loadManifest(repoRoot);
	const relForManifest = path.relative(repoRoot, targetAbs).split(path.sep).join('/');
	if (text.includes(BSKEL_GENERATED_MARKER) || Object.hasOwn(manifest.files, relForManifest)) {
		throw new JavaSplicePlanError(`"${file}" is bskel-generated (carries the "${BSKEL_GENERATED_MARKER}" marker, or is tracked in .sbf/handles-manifest.json) -- a later \`handles emit\` would silently overwrite a splice here; edit the template or the resolver-ownership path instead`);
	}

	const lineTerminator = detectLineTerminator(text);
	if (lineTerminator === '\r\n') {
		throw new JavaSplicePlanError(`"${file}" uses CRLF line endings -- refusing rather than risk mixed line endings after a splice. Convert the file to LF first.`);
	}

	const detection = detectAstHelperAvailable();
	if (!detection.available) {
		throw new JavaSplicePlanError(detection.reason);
	}
	const build = detectBuildCommand(repoRoot);
	if (!build) {
		throw new JavaSplicePlanError('no recognized build tool (gradlew/pom.xml/package.json) found -- a postcondition that could never run is not a postcondition');
	}

	const srcRoot = detectJavaSpringRoot(repoRoot);
	if (!srcRoot) {
		throw new JavaSplicePlanError(`could not find a Java "src/main/java" root above "${file}" (no build.gradle/pom.xml with a sibling src/main/java) -- java-source-splice only supports the standard Maven/Gradle layout`);
	}

	const locators = edits
		.filter((e) => e.op !== 'add-import')
		.map((e) => ({
			type_fqn: e.locator.type_fqn,
			member_kind: e.locator.member_kind,
			member_name: e.locator.member_name,
			erased_param_types: e.locator.erased_param_types ?? [],
		}));

	let astResult = { topLevelTypes: [], results: [] };
	if (locators.length > 0) {
		astResult = await runAstLocate(targetAbs, srcRoot, locators);
		if (astResult.topLevelTypes.length !== 1) {
			throw new JavaSplicePlanError(`"${file}" declares ${astResult.topLevelTypes.length} top-level type(s) (${astResult.topLevelTypes.join(', ') || 'none'}) -- java-source-splice V1 only supports a file with exactly one top-level type`);
		}
	}

	const masked = maskNonCode(text);
	let locatorResultIndex = 0;
	const enrichedEdits = [];
	const occupiedRanges = []; // {start, end} in ORIGINAL text, for overlap detection

	for (const e of edits) {
		if (e.op === 'add-import') {
			const region = findImportsRegion(text);
			const originalRegionText = text.slice(region.start, region.end);
			const fqn = e.imports[0];
			if (isDuplicateImport(text, fqn)) {
				throw new JavaSplicePlanError(`"${file}" already imports "${fqn}" -- nothing to add`);
			}
			const finalReplacement = `${originalRegionText}${originalRegionText ? lineTerminator : ''}import ${fqn};`;
			if (!finalReplacement.startsWith(originalRegionText)) {
				throw new JavaSplicePlanError('internal error: add-import built a replacement that does not start with the existing imports verbatim');
			}
			occupiedRanges.push({ start: region.start, end: region.end });
			enrichedEdits.push({
				op: e.op,
				imports: e.imports,
				region_hash: sha256String(originalRegionText),
				signature_hash: null,
				located: { start: region.start, end: region.end, begin_line: null, end_line: null },
				_start: region.start,
				_end: region.end,
				_finalReplacement: finalReplacement,
			});
			continue;
		}

		const result = astResult.results[locatorResultIndex++];
		if (!result || !result.resolved) {
			throw new JavaSplicePlanError(`could not locate ${e.locator.member_kind} "${e.locator.member_name}" in "${e.locator.type_fqn}": ${result?.error ?? 'no result returned by the AST helper'}`);
		}
		if ((result.unresolvedParamTypes ?? []).length > 0) {
			throw new JavaSplicePlanError(`"${e.locator.member_name}" in "${e.locator.type_fqn}" has unresolvable parameter type(s) (${result.unresolvedParamTypes.join(', ')}) -- refusing to splice a member whose own signature this tool cannot fully resolve`);
		}

		const regionStart = lineColToOffset(text, result.beginLine, result.beginColumn);
		const regionEnd = lineColToOffset(text, result.endLine, result.endColumn) + 1; // AST end is inclusive of the last char
		const regionText = text.slice(regionStart, regionEnd);
		if (regionText !== result.regionText) {
			throw new JavaSplicePlanError(`internal error: offset-converted region text for "${e.locator.member_name}" does not match the AST helper's own reported text -- refusing rather than risk mis-splicing (this should be unreachable; please report it)`);
		}

		const sigStart = lineColToOffset(text, result.signatureBeginLine, result.signatureBeginColumn);
		const sigEnd = lineColToOffset(text, result.signatureEndLine, result.signatureEndColumn) + 1;
		const signatureText = text.slice(sigStart, sigEnd);
		if (signatureText !== result.signatureText) {
			throw new JavaSplicePlanError(`internal error: offset-converted signature text for "${e.locator.member_name}" does not match the AST helper's own reported text -- refusing rather than risk mis-splicing (this should be unreachable; please report it)`);
		}

		const kind = e.locator.member_kind === 'field' ? 'field' : 'method';
		if (!independentFalsifierAgrees(masked, e.locator.member_name, regionStart, kind)) {
			throw new JavaSplicePlanError(`the independent (non-AST) locator check disagrees with the AST helper for "${e.locator.member_name}" in "${e.locator.type_fqn}" -- refusing rather than trust a single mechanism for something this consequential`);
		}

		let finalReplacement;
		if (e.op === 'replace-method-body') {
			const candidate = e.replacement;
			if (!candidate.startsWith('{') || !candidate.trimEnd().endsWith('}')) {
				throw new JavaSplicePlanError(`replace-method-body's replacement for "${e.locator.member_name}" must start with "{" and end with "}"`);
			}
			if (candidate.includes('\r\n')) {
				throw new JavaSplicePlanError(`replace-method-body's replacement for "${e.locator.member_name}" contains CRLF line endings, but "${file}" uses LF -- refusing to mix line endings`);
			}
			const closeIdx = matchBalanced(maskNonCode(candidate), 0, '{', '}');
			if (closeIdx !== candidate.trimEnd().length - 1) {
				throw new JavaSplicePlanError(`replace-method-body's replacement for "${e.locator.member_name}" is not brace-balanced`);
			}
			finalReplacement = candidate;
		} else if (e.op === 'insert-method-body-prologue') {
			finalReplacement = deriveProloguePrefix(regionText, e.statements, lineTerminator);
		} else if (e.op === 'replace-field-initializer') {
			finalReplacement = e.replacement;
		}

		occupiedRanges.push({ start: regionStart, end: regionEnd });
		enrichedEdits.push({
			op: e.op,
			locator: e.locator,
			...(e.op !== 'insert-method-body-prologue' ? { replacement: e.replacement } : { statements: e.statements }),
			region_hash: sha256String(regionText),
			signature_hash: sha256String(signatureText),
			located: { start: regionStart, end: regionEnd, begin_line: result.beginLine, end_line: result.endLine },
			_start: regionStart,
			_end: regionEnd,
			_finalReplacement: finalReplacement,
		});
	}

	assertNoOverlaps(occupiedRanges, file);
	const rendered = assertOnlyRegionsChanged(text, enrichedEdits);

	const parseResult = await runAstParse(rendered);
	if (!parseResult.ok) {
		throw new JavaSplicePlanError(`the proposed splice does not parse as valid Java:\n${(parseResult.problems ?? []).join('\n')}`);
	}

	const regionHash = computeMerkleRegionHash(enrichedEdits);

	const publicEdits = enrichedEdits.map(({ _start, _end, _finalReplacement, ...rest }) => rest);
	const memberSummary = publicEdits
		.map((e) => (e.locator ? `${e.locator.member_name}` : `import ${e.imports[0]}`))
		.join(', ');

	return {
		target: {
			file,
			source_root: path.relative(repoRoot, srcRoot).split(path.sep).join('/'),
			line_terminator: lineTerminator,
			edits: publicEdits,
		},
		preimage: { region_hash: regionHash, file_hash: sha256String(text) },
		current_value: `${publicEdits.length} edit(s) to ${memberSummary}`,
		proposed_value: unifiedDiff(file, text, rendered),
		postcondition: { kind: 'java-compiles', build_tool: build.tool, build_command: `${build.cmd} ${build.args.join(' ')}` },
		originalContent: text,
		renderedContent: rendered,
	};
}

// ---------------------------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------------------------

// D6: write, then compile -- the filesystem transposition of ddl-apply's real Postgres
// BEGIN/COMMIT/ROLLBACK. A compile failure restores the ORIGINAL bytes from the CAS blob before
// throwing -- the transaction record itself stays "approved", not "applied", so a retry (a fresh
// propose against the still-unsplice-broken file) is the natural next step.
export async function executeJavaSpliceApply(root, featureId, txn, freshKindPlan) {
	const targetAbs = path.join(root, txn.target.file);
	fs.writeFileSync(targetAbs, freshKindPlan.renderedContent);
	const buildResult = runBuildCheck(root);
	if (!buildResult.ok) {
		const original = readBlob(root, featureId, txn.preimage.file_hash);
		fs.writeFileSync(targetAbs, original);
		throw new JavaSpliceExecutionError(
			`the splice was written but the project failed to compile -- "${txn.target.file}" has been restored to its original content.\n\n${buildResult.message}`,
		);
	}
	return { postimage_file_hash: sha256String(freshKindPlan.renderedContent), build_tool: buildResult.tool };
}

// D7: byte-exact whole-file restore from the CAS blob, mirroring executeConfigRollback() exactly,
// plus a compile check afterward (recorded, not enforced -- restoring a KNOWN-GOOD prior state
// must never be refused just because something ELSE in the repo is currently broken).
export async function executeJavaSpliceRollback(root, featureId, txn, { force = false } = {}) {
	const targetAbs = path.join(root, txn.target.file);
	const currentHash = sha256File(targetAbs);
	if (currentHash !== txn.apply.postimage_file_hash && !force) {
		throw new JavaSpliceExecutionError(
			`"${txn.target.file}" has changed since transaction "${txn.transaction_id}" applied -- rolling back would silently clobber that change; pass --force --reason if intentional`,
		);
	}
	const original = readBlob(root, featureId, txn.preimage.file_hash);
	fs.writeFileSync(targetAbs, original);
	const buildResult = runBuildCheck(root);
	return { compile_after_rollback: buildResult.ok ? 'ok' : 'failed' };
}

// Retyping which hand-written member(s) are being rewritten is the actual attention check --
// an add-import-only transaction is purely additive, so it falls back to the transaction id
// (ddl-apply's own non-destructive fallback, same reasoning).
export function requiredConfirmValue(txn) {
	const destructive = txn.target.edits.filter((e) => DESTRUCTIVE_OPS.has(e.op));
	if (destructive.length === 0) return txn.transaction_id;
	const members = destructive.map((e) => `${e.locator.type_fqn.split('.').pop()}#${e.locator.member_name}`);
	return [...new Set(members)].sort().join(',');
}

// Consulted by bin/bskel.mjs's cmdPatchApprove/cmdPatchApply only when replanTransaction() throws
// StaleTransactionError -- names which edit's stored hash no longer matches the fresh one, and
// which of region_hash/signature_hash moved, plus a whole-file diff against the fresh content
// recovered from the original preimage blob.
export function describeStaleness(root, txn, freshPlan) {
	const lines = [];
	const stored = txn.target.edits;
	const fresh = freshPlan.target.edits;
	for (let i = 0; i < Math.max(stored.length, fresh.length); i++) {
		const s = stored[i];
		const f = fresh[i];
		if (!s || !f) {
			lines.push(`  edit ${i}: edit list shape changed`);
			continue;
		}
		const what = s.locator ? `${s.locator.type_fqn}#${s.locator.member_name}` : `add-import ${s.imports?.[0]}`;
		if (s.region_hash !== f.region_hash) lines.push(`  edit ${i} (${what}): region content changed`);
		if (s.signature_hash !== f.signature_hash) lines.push(`  edit ${i} (${what}): signature changed (e.g. return type, modifiers)`);
	}
	let diffText = '';
	try {
		const original = readBlob(root, txn.feature_id, txn.preimage.file_hash);
		const currentAbs = path.join(root, txn.target.file);
		const current = fs.readFileSync(currentAbs, 'utf8');
		diffText = unifiedDiff(txn.target.file, original, current);
	} catch {
		// best-effort diagnostics only
	}
	return [`transaction "${txn.transaction_id}"'s target has changed since it was proposed:`, ...lines, diffText]
		.filter(Boolean)
		.join('\n');
}
