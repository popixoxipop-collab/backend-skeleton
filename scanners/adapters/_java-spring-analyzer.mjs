// A2 Phase 1 (D-java-analyzer): a dependency-free, balanced-token/masking analyzer that replaces
// the ad-hoc regex Java-source parsing previously duplicated across scanners/adapters/
// java-spring.mjs, contracts/emit.mjs, and handles/providers/java-spring/plan.mjs. See
// D-java-analyzer in DECISIONS.md for the exact known-broken shapes this fixes (test/fixtures/
// java-spring/.../annotationstyles/presentation/, pinned by P3/D-fixture-corpus as this item's
// own before/after baseline).
//
// LEADING UNDERSCORE IS LOAD-BEARING, NOT STYLISTIC: scanners/registry.mjs's candidateFiles()
// treats every non-`_`/`.`-prefixed .mjs file directly under scanners/adapters/ as a candidate
// scanner adapter to dynamically import() and validate against sbf.adapter/1 -- this file exports
// pure functions only, no `adapter`, and a non-underscored name would land in LOAD_ERRORS as a
// broken adapter (the registry's own comment already documents this exact convention).
import { lineNumberAt } from '../text-util.mjs';

const MASK_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"/g;

// Same length, same line breaks (newlines preserved) as `text`, every OTHER character's index
// staying identical. A comment (block or line) is blanked to spaces ENTIRELY, markers included --
// it should never look structurally like anything. A string literal (regular or a Java text
// block) keeps its own opening/closing quote delimiters and blanks only the INTERIOR -- found
// live while wiring this up: blanking the quotes too broke `operationId\s*=\s*"` position-finding
// for every REAL annotation, not just phantom comment mentions, since the pattern needs a literal
// `"` right after `=` to know a quoted value follows at all. Used for every STRUCTURAL scan (where
// a class/annotation/method starts) so a comment or a string's CONTENT can never masquerade as
// code -- this is what fixes the phantom-operationId bug (a `//` comment mentioning
// `operationId = "..."` as prose) as a side effect, not a special case. VALUES (e.g. a real
// annotation's quoted path) are never read off the masked text -- every value-extraction step
// re-slices the ORIGINAL text at the offset the masked scan found, since masking never shifts
// offsets, only blanks content.
export function maskNonCode(text) {
	return text.replace(MASK_RE, (m) => {
		if (m.startsWith('"""')) return `"""${m.slice(3, -3).replace(/[^\n]/g, ' ')}"""`;
		if (m.startsWith('"')) return `"${m.slice(1, -1).replace(/[^\n]/g, ' ')}"`;
		return m.replace(/[^\n]/g, ' ');
	});
}

// Generic balanced-delimiter scanner -- `text[openIndex]` must be `openChar`. Same algorithm
// scanners/adapters/python-fastapi.mjs's own local matchBalancedParens() already uses for `(`/`)`
// (a decorator's own kwargs routinely nest parens); parameterized here so one function also
// covers `<`/`>` (a generic return type's own nested generics, e.g. Map<String, List<Foo>>).
// python-fastapi.mjs's copy is left untouched -- same algorithm, but touching an already-working,
// unrelated adapter for a cosmetic dedup isn't a risk this item needs to take.
export function matchBalanced(text, openIndex, openChar, closeChar) {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		if (text[i] === openChar) depth++;
		else if (text[i] === closeChar) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

// D-entity-id-field-inheritance: `\b` before `(class|record)` -- found live, not anticipated,
// while verifying a real cross-file inheritance walk against `@MappedSuperclass`-annotated Java
// (spring-petclinic's own `BaseEntity`). Without it, `class`/`record` could match as a SUBSTRING of
// a preceding identifier that happens to end the same way -- `@MappedSuperclass\npublic class
// BaseEntity` matched "class" inside "Superclass" itself (no `\w`-to-non-`\w` transition exists
// between "Super" and "class", so no real word boundary there either way), then captured the next
// bare word ("public") as if it were the class name. `\s+` alone was never sufficient protection --
// it only requires whitespace AFTER the match, never a real word start before it.
const CLASS_OR_RECORD_RE = /(?:public\s+)?\b(class|record)\s+(\w+)/;

// Adds `record` support and makes `public` optional (a package-private class is still a legal
// Spring bean) in the one place both extractController() and extractEntity() already duplicate
// this exact pattern. Operates on masked text -- callers pass maskNonCode(text).
export function findClassOrRecordDeclaration(maskedText) {
	const m = maskedText.match(CLASS_OR_RECORD_RE);
	if (!m) return null;
	return { keyword: m[1], name: m[2], index: m.index };
}

const WHITESPACE_RE = /^\s*/;
// A2 Phase 2 (D-java-ast-helper): `[\w.]+`, not `\w+` -- found live while building the real
// JavaParser/Symbol-Solver AST cross-check. A fully-qualified annotation
// (`@jakarta.validation.constraints.NotNull`) is legal, ordinary Java; the old `\w+`-only pattern
// matched just `@jakarta`, so skipAnnotationsAndWhitespace() stopped mid-annotation and left
// `.validation.constraints.NotNull String description` as "the rest" -- which extractTypeAndName()
// (patch-strategy.mjs) then misparsed as `baseType=".validation.constraints.NotNull"`,
// `fieldName="String"`, silently corrupting an unrelated field's own name and type, not merely
// failing to recognize the annotation's meaning. This is a structural parse fix, not a semantic
// one -- a fully-qualified `@NotNull` still isn't recognized as meaning NotNull by
// `/@NotNull\b/`-style literal checks (patch-strategy.mjs's classifyParam, plan.mjs's authority
// search); that gap is exactly what `--ast`'s cross-check exists to surface, not paper over here.
const ANNOTATION_START_RE = /^@[\w.]+/;
const MODIFIER_RE = /^(?:public|protected)?\s*(?:static\s+)?/;
const IDENTIFIER_RE = /^[\w.]+/;
const METHOD_NAME_RE = /^(\w+)\s*\(/;

// From `index`, repeatedly skips whitespace (masked comments blank to spaces, so this skips them
// too, for free) and any COMPLETE annotation (`@Word` + an optional balanced `(...)` arg list),
// stopping at the first position that is neither. This one general mechanism is what makes
// same-line mappings, intervening annotations, and comments-in-between all "just work" instead of
// needing a special case per broken shape. Operates on masked text.
export function skipAnnotationsAndWhitespace(maskedText, index) {
	let i = index;
	for (;;) {
		const ws = maskedText.slice(i).match(WHITESPACE_RE);
		i += ws[0].length;
		const ann = maskedText.slice(i).match(ANNOTATION_START_RE);
		if (!ann) return i;
		i += ann[0].length;
		if (maskedText[i] === '(') {
			const close = matchBalanced(maskedText, i, '(', ')');
			if (close === -1) return i; // malformed -- stop here rather than loop forever
			i = close + 1;
		}
	}
}

// From the position skipAnnotationsAndWhitespace() returns, matches an optional public|protected
// modifier, optional static, a return type (an identifier optionally followed by a balanced
// <...> generic and/or []), a method name, and the balanced parameter-list parens. Returns null
// if nothing method-shaped follows -- e.g. a class-level annotation stack that precedes `class`,
// not a method -- a legitimate, silent skip, not an error. `private` is deliberately excluded:
// Spring never routes a private method as an endpoint. Operates on masked text.
export function matchMethodSignatureAfter(maskedText, index) {
	let i = index;
	const mod = maskedText.slice(i).match(MODIFIER_RE);
	i += mod[0].length;

	const type = maskedText.slice(i).match(IDENTIFIER_RE);
	if (!type) return null;
	i += type[0].length;

	if (maskedText[i] === '<') {
		const close = matchBalanced(maskedText, i, '<', '>');
		if (close === -1) return null;
		i = close + 1;
	}
	while (maskedText.slice(i, i + 2) === '[]') i += 2;

	const ws = maskedText.slice(i).match(WHITESPACE_RE);
	i += ws[0].length;

	const nameMatch = maskedText.slice(i).match(METHOD_NAME_RE);
	if (!nameMatch) return null;
	const methodName = nameMatch[1];
	const parensOpen = i + nameMatch[0].length - 1; // index of the method's own '('
	const parensClose = matchBalanced(maskedText, parensOpen, '(', ')');
	if (parensClose === -1) return null;

	return { methodName, paramsStart: parensOpen + 1, paramsEnd: parensClose, matchEnd: parensClose + 1 };
}

const MAPPING_VERBS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];
const MAPPING_ANNOTATION_RE = new RegExp(`@(?:(${MAPPING_VERBS.join('|')})Mapping|RequestMapping)\\b`, 'g');
const REQUEST_MAPPING_RE = /@RequestMapping\b/g;
const CLASS_OR_RECORD_START_RE = /^(?:public\s+)?(?:class|record)\b/;
const REQUEST_MAPPING_METHOD_RE = /\bmethod\s*=\s*RequestMethod\.(\w+)\b/;

// True when `class`/`record` is the next real declaration after `index`, ONE OR MORE further
// annotations allowed in between (e.g. a real oracle shape: `@RequestMapping(...)
// @RequiredArgsConstructor public class Foo` -- found live, not anticipated, while verifying this
// item against the real Team-IZ-Backend repo: a rigid "class/record within the next N chars"
// lookahead missed exactly this, the same intervening-annotation problem
// skipAnnotationsAndWhitespace() already solves for methods, just not yet applied here too).
function isClassOrRecordAhead(masked, index) {
	const after = skipAnnotationsAndWhitespace(masked, index);
	return CLASS_OR_RECORD_START_RE.test(masked.slice(after, after + 50));
}

// The class-level counterpart findMappingAnnotations() deliberately skips -- a @RequestMapping
// that (mod whitespace and any further annotations) precedes `class`/`record` is the controller's
// own base path, not a method. Returns the raw, ORIGINAL-text (unmasked) args substring, or null
// if this class has no class-level @RequestMapping at all. Shares the exact same lookahead helper
// findMappingAnnotations() excludes by, so the two functions can never disagree about which
// @RequestMapping occurrence is the class-level one.
export function findClassLevelMappingArgs(text) {
	const masked = maskNonCode(text);
	let m;
	REQUEST_MAPPING_RE.lastIndex = 0;
	while ((m = REQUEST_MAPPING_RE.exec(masked))) {
		let i = m.index + m[0].length;
		let argsStart = -1;
		let argsEnd = -1;
		if (masked[i] === '(') {
			const close = matchBalanced(masked, i, '(', ')');
			if (close === -1) continue;
			argsStart = i + 1;
			argsEnd = close;
			i = close + 1;
		}
		if (isClassOrRecordAhead(masked, i)) {
			return argsStart >= 0 ? text.slice(argsStart, argsEnd) : '';
		}
	}
	return null;
}

// The one shared orchestrator both scanners/adapters/java-spring.mjs's extractController() and
// handles/providers/java-spring/plan.mjs's method-boundary search need. Masks once, finds every
// METHOD-level `@(Get|Post|Put|Patch|Delete)Mapping`/`@RequestMapping` occurrence (a `@RequestMapping`
// immediately followed by `class`/`record` is class-level basePath, not a method -- skipped here,
// handled by the caller's own class-level logic), resolves each one's verb (a shorthand's own
// name, or `method = RequestMethod.X` parsed from `@RequestMapping`'s own args -- single-verb
// only, matching the catalog's own literal `@RequestMapping(method=…)` wording; a `method = {A,
// B}` array is left unresolved and skipped, a documented gap, not silently guessed at), and
// confirms a real method signature follows. Returns entries in document order: `{index, verb,
// argsText, methodName, methodLine}` -- `argsText` and `methodLine` are always computed from the
// ORIGINAL (unmasked) `text`, never the masked copy, since real annotation argument values (e.g.
// a path string) must never be read from blanked-out content.
export function findMappingAnnotations(text) {
	const masked = maskNonCode(text);
	const results = [];
	let m;
	MAPPING_ANNOTATION_RE.lastIndex = 0;
	while ((m = MAPPING_ANNOTATION_RE.exec(masked))) {
		const atIndex = m.index;
		const verbShorthand = m[1];
		const isRequestMapping = verbShorthand === undefined;
		let i = atIndex + m[0].length;

		let argsStart = -1;
		let argsEnd = -1;
		if (masked[i] === '(') {
			const close = matchBalanced(masked, i, '(', ')');
			if (close === -1) continue; // malformed -- skip, don't misattribute
			argsStart = i + 1;
			argsEnd = close;
			i = close + 1;
		}

		if (isRequestMapping && isClassOrRecordAhead(masked, i)) {
			continue; // class-level @RequestMapping -- the caller's own basePath logic handles this
		}

		let verb;
		if (verbShorthand) {
			verb = verbShorthand.toUpperCase();
		} else {
			const argsOriginal = argsStart >= 0 ? text.slice(argsStart, argsEnd) : '';
			const methodMatch = argsOriginal.match(REQUEST_MAPPING_METHOD_RE);
			if (!methodMatch) continue; // no single-verb method= found -- unresolved, documented gap
			verb = methodMatch[1].toUpperCase();
		}

		const afterAnnotations = skipAnnotationsAndWhitespace(masked, i);
		const sig = matchMethodSignatureAfter(masked, afterAnnotations);
		if (!sig) continue; // nothing method-shaped follows -- legitimate skip, not an error

		results.push({
			index: atIndex,
			verb,
			argsText: argsStart >= 0 ? text.slice(argsStart, argsEnd) : '',
			methodName: sig.methodName,
			methodLine: lineNumberAt(text, atIndex),
		});
	}
	return results;
}

// A2 Phase 1: return type tolerates a generic nested up to 2 levels (e.g.
// ResponseEntity<Map<String, Object>>) via a manually-unrolled pattern -- a pragmatic, bounded
// trade-off, not a general parser (this file's own matchBalanced() already handles arbitrary
// nesting where it's used above; a real Spring controller return type in this codebase never
// nests deeper than this, so a bounded pattern is enough for Phase 1's own stated scope).
const RETURN_TYPE_RE = '[\\w.]+(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?(?:\\[\\])?';

// Finds `methodName`'s own parameter-list text -- used by contracts/emit.mjs's
// detectRequestBody(). Confirmed live (not assumed) against the previous non-greedy `([\s\S]*?)
// \)\s*\{` regex: a return type with a space inside a generic (`ResponseEntity<Map<String,
// Object>>`) failed to match AT ALL (the old regex's `\S+` return-type slot can't span
// whitespace), the exact same root cause scanners/adapters/java-spring.mjs's
// GenericWithSpaceController fixture already pins for extractController(). Returns the ORIGINAL
// (unmasked) parameter-list text, found via matchBalanced() from the method's own `(` --
// correctly bounded regardless of a default-value expression's own nested parens (e.g.
// `@RequestParam(defaultValue = "false") boolean force`) by construction, not by the old regex's
// accidental correctness. Returns null if no declaration of `methodName` is found.
export function findMethodParams(text, methodName) {
	const masked = maskNonCode(text);
	const declRe = new RegExp(`(?:public|protected)?\\s*(?:static\\s+)?${RETURN_TYPE_RE}\\s+${methodName}\\s*\\(`);
	const m = masked.match(declRe);
	if (!m) return null;
	const parenOpen = m.index + m[0].length - 1; // index of the method's own '('
	const parenClose = matchBalanced(masked, parenOpen, '(', ')');
	if (parenClose === -1) return null;
	return text.slice(parenOpen + 1, parenClose);
}
