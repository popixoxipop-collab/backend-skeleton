// O6: documentation-integrity checks -- a stale `D-<x>`/`D<N>` reference (code or docs pointing
// at a decision that doesn't exist, or no longer exists under that name) used to be something
// only a human happened to notice while reading (see DECISIONS.md's D-artifact-determinism for
// the D-db/D8/HandleAspect cases this fixed). This file makes that class of drift a test failure
// instead. Genuinely new infrastructure -- no existing test reads DECISIONS.md/SKILL.md/CATALOG.md
// at all (confirmed before writing this).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const DECISIONS_MD = path.join(REPO_ROOT, 'DECISIONS.md');
const THIS_FILE = fileURLToPath(import.meta.url);

// Pure, exported so the "does this actually catch a real break" subtest below can feed it a
// synthetic string instead of the real DECISIONS.md -- a doc-integrity test that can only ever
// pass is worth nothing.
//
// Two things a naive "## D-<x> is a real heading" scan gets wrong, both found while researching
// this item:
//   1. `## Security hardening pass (Codex review)` documents D-security-1..N as a NUMBERED LIST
//      under one heading, not as N separate `## D-security-N` headings -- this section says so
//      explicitly ("this section is the index, not a duplicate of the reasoning"). Counting the
//      list items and synthesizing D-security-1..N anchors is what avoids ~10 false positives.
//   2. A combined heading (`## D5/D6 (implemented): ...`, `## D-name / D-repo / D-handles /
//      D-ngrok`) defines MULTIPLE anchors on one line -- must split on `/`, not just take the
//      first token.
export function parseDecisionAnchors(decisionsMdText) {
	const anchors = new Set();
	const lines = decisionsMdText.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^## (.+)$/);
		if (!m) continue;
		const heading = m[1];
		if (/^Security hardening pass\b/.test(heading)) {
			let maxItem = 0;
			for (let j = i + 1; j < lines.length && !/^## /.test(lines[j]); j++) {
				const item = lines[j].match(/^(\d+)\.\s/);
				if (item) maxItem = Math.max(maxItem, Number(item[1]));
			}
			for (let k = 1; k <= maxItem; k++) anchors.add(`D-security-${k}`);
			continue;
		}
		const label = heading.split(/[:(]/)[0].trim();
		for (const token of label.split('/').map((t) => t.trim())) {
			if (/^D[-\d]/.test(token)) anchors.add(token);
		}
	}
	return anchors;
}

// Repo-relative extensions worth checking -- source, templates, and top-level docs. Excluded:
// node_modules/.git (vendor/vcs, not this project's own content); CATALOG.md (an explicitly
// FROZEN, verbatim-recovered historical record of Codex's original catalog text -- per its own
// header, editing quoted text there would misrepresent what Codex actually wrote, so it
// intentionally still contains the original D-db/D8 mentions as evidence of the problem O6 fixed
// elsewhere -- see DECISIONS.md's D-artifact-determinism); and this file itself (its own source
// constructs D-security-${k} via template literal and deliberately references nonexistent tokens
// in its synthetic self-verification subtests -- neither is a real documentation reference).
const SCAN_EXTENSIONS = new Set(['.mjs', '.tmpl', '.md']);
const EXCLUDED_DIRS = new Set(['node_modules', '.git']);
const EXCLUDED_FILES = new Set([path.join(REPO_ROOT, 'CATALOG.md'), THIS_FILE]);

function walkFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (EXCLUDED_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full));
		else if (SCAN_EXTENSIONS.has(path.extname(entry.name)) && !EXCLUDED_FILES.has(full)) out.push(full);
	}
	return out;
}

// D-security-N is this repo's own placeholder spelling for "any D-security item" (used twice in
// DECISIONS.md's own prose describing the convention) -- not a literal reference. A `-shaped`
// suffix (`D-security-1-shaped`, established in test/gate-definitions.test.mjs and
// test/contract-cli.test.mjs) means "same class of defense as", not a distinct anchor.
const TOKEN_RE = /\bD-[a-zA-Z][a-zA-Z0-9-]*\b|\bD[0-9]+\b/g;

export function findDanglingReferences(files, anchors) {
	const dangling = [];
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		for (const raw of text.matchAll(TOKEN_RE)) {
			let token = raw[0];
			if (token === 'D-security-N') continue;
			token = token.replace(/-shaped$/, '');
			if (!anchors.has(token)) dangling.push({ file: path.relative(REPO_ROOT, file), token });
		}
	}
	return dangling;
}

test('every D-<x>/D<N> token referenced in source, templates, or live docs resolves to a real DECISIONS.md anchor', () => {
	const anchors = parseDecisionAnchors(fs.readFileSync(DECISIONS_MD, 'utf8'));
	const dangling = findDanglingReferences(walkFiles(REPO_ROOT), anchors);
	assert.deepEqual(dangling, [], `dangling decision reference(s) found:\n${dangling.map((d) => `  ${d.file}: ${d.token}`).join('\n')}`);
});

// The D-security-N numbered-list convention is the single biggest false-positive trap for this
// kind of check (found during research for this item) -- lock in that it's actually handled,
// independent of whatever DECISIONS.md happens to look like today.
test('the D-security-N numbered-list convention resolves without false positives', () => {
	const anchors = parseDecisionAnchors([
		'## Security hardening pass (Codex review)',
		'',
		'Some prose.',
		'',
		'1. **First finding**',
		'2. **Second finding**',
		'3. **Third finding**',
		'',
		'## Something else',
		'',
	].join('\n'));
	assert.deepEqual([...anchors].sort(), ['D-security-1', 'D-security-2', 'D-security-3']);
});

// A combined heading defines multiple anchors -- both the slash-separated-with-colon shape and
// the bare slash-separated shape (both real examples in this repo's own DECISIONS.md).
test('a combined heading (D5/D6 or D-a / D-b / D-c) defines one anchor per token', () => {
	const anchors = parseDecisionAnchors(['## D5/D6 (implemented): composite thing', '', '## D-a / D-b / D-c', ''].join('\n'));
	assert.deepEqual([...anchors].sort(), ['D-a', 'D-b', 'D-c', 'D5', 'D6']);
});

// Self-verification: a doc-integrity check that can only ever pass is worthless. Feed
// findDanglingReferences a synthetic file referencing a token that isn't in the anchor set, and
// confirm it's actually reported -- proves the detection logic itself can fail, not just that
// today's repo happens to be clean.
test('findDanglingReferences actually detects an injected dangling reference', () => {
	const tmpFile = path.join(REPO_ROOT, '.doc-integrity-test-fixture.mjs');
	const missingToken = ['D', '-', 'this', '-', 'decision', '-', 'does', '-', 'not', '-', 'exist'].join('');
	fs.writeFileSync(tmpFile, `// see ${missingToken} for details\n`);
	try {
		const dangling = findDanglingReferences([tmpFile], new Set(['D-something-else']));
		assert.deepEqual(dangling, [{ file: '.doc-integrity-test-fixture.mjs', token: missingToken }]);
	} finally {
		fs.rmSync(tmpFile);
	}
});

// O6 (b): usage()'s documented top-level commands must all actually be recognized by the
// dispatch switch in main() -- confirmed no drift exists today, this is a regression guard.
// Detects drift by running each documented verb bare and checking the output does NOT start with
// usage()'s own banner (which only prints when main()'s `default:` branch -- i.e. an unrecognized
// command -- is hit).
// O6 (b): usage()'s documented top-level commands must all actually be recognized by the
// dispatch switch in main() -- confirmed no drift exists today, this is a regression guard.
//
// Static source parsing, not runtime probing: an earlier draft ran `bskel <verb>` bare and
// checked whether it fell through to usage()'s own banner text -- but a PARENT verb like `feature`
// (real subcommand: `feature init`) legitimately prints that same banner when called with no
// subcommand (main()'s own `case 'feature':` block calls usage() itself for "you gave me an
// incomplete command"), which is indistinguishable at the output level from "dispatch doesn't
// recognize this verb at all". Comparing the verb SET parsed from usage()'s text against the
// case-label SET parsed from main()'s switch sidesteps that ambiguity entirely.
test('every top-level command documented in usage() has a matching case label in the CLI dispatch switch', () => {
	const source = fs.readFileSync(CLI, 'utf8');
	const usageBody = source.match(/function usage\(\) \{\s*console\.error\(`([\s\S]*?)`\);\s*\n\}/);
	assert.ok(usageBody, 'could not locate usage()\'s template literal in bin/bskel.mjs -- did its shape change?');
	const verbs = [...usageBody[1].matchAll(/^\s{2}bskel (\S+)/gm)].map((m) => m[1]).filter((v, i, arr) => arr.indexOf(v) === i);
	assert.ok(verbs.length > 5, `expected to parse several commands out of usage(), got: ${JSON.stringify(verbs)}`);

	const mainBody = source.slice(source.indexOf('function main()'));
	assert.ok(mainBody.length > 0, 'could not locate main() in bin/bskel.mjs -- did its shape change?');
	const caseLabels = new Set([...mainBody.matchAll(/case '([\w-]+)':/g)].map((m) => m[1]));

	for (const verb of verbs) {
		assert.ok(caseLabels.has(verb), `\`bskel ${verb}\` is documented in usage() but has no matching case '${verb}': in main()'s dispatch switch`);
	}
});

// O6 (c): the HandleAspect fix specifically -- if it's ever reintroduced, it must carry an
// explicit "not yet implemented" caveat, not silently claim a class that doesn't exist.
test('any HandleAspect reference in a generated template is explicitly caveated as not yet implemented', () => {
	const templatesDir = path.join(REPO_ROOT, 'handles', 'providers', 'java-spring', 'templates');
	for (const file of fs.readdirSync(templatesDir)) {
		if (!file.endsWith('.tmpl')) continue;
		const text = fs.readFileSync(path.join(templatesDir, file), 'utf8');
		if (!text.includes('HandleAspect')) continue;
		assert.match(text, /HandleAspect[\s\S]{0,80}NOT YET IMPLEMENTED/i, `${file} references HandleAspect without an explicit not-yet-implemented caveat nearby`);
	}
});
