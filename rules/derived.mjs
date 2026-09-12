// D-business-rules (R5/R9, Phase 3): pure, shared rendering for a `derived` rule's compiled expr
// tree into real source. One function, reused by all three providers, rather than three drifting
// copies -- possible ONLY because the closed operator set (add/sub/mul/div) happens to share
// identical infix syntax across Java, Python, and TypeScript when every operand is typed
// numerically (no operator overloading ambiguity, no language-specific precedence quirks at this
// grammar's depth). If a future op ever needed different per-language syntax, this is the single
// place that assumption would break and need splitting -- named here, not discovered by surprise.
//
// Validation of an authored expr tree lives in rules/compile.mjs (the "decide semantics once in
// JS" doctrine every other rule kind already follows) -- this module ONLY renders an
// already-validated tree. It never throws on a well-formed tree; a malformed one is a compiler
// bug upstream, not this module's concern to defend against a second time.
import { DERIVED_OPS } from './vocabulary.mjs';

const OP_SYMBOLS = Object.freeze({ add: '+', sub: '-', mul: '*', div: '/' });

/**
 * Renders an already-validated expr node as a parenthesized infix expression, e.g.
 * `((price * quantity) - discount)`. `refName` maps a `{ref}` leaf's name to the exact identifier
 * to emit -- callers pass a per-language transform (e.g. Java/TS keep the name as-is, Python
 * might not need one at all since parameter names are already valid Python identifiers by
 * construction, see collectParams()'s own identifier rule).
 */
export function renderExprInfix(node, refName = (name) => name) {
	if (Object.hasOwn(node, 'ref')) return refName(node.ref);
	if (Object.hasOwn(node, 'const')) return formatConst(node.const);
	if (Object.hasOwn(node, 'op') && DERIVED_OPS.includes(node.op)) {
		const [left, right] = node.args;
		return `(${renderExprInfix(left, refName)} ${OP_SYMBOLS[node.op]} ${renderExprInfix(right, refName)})`;
	}
	// Unreachable for a tree that passed rules/compile.mjs's own validateDerivedExpr() --
	// deliberately throws rather than emitting silently-wrong source if it somehow is.
	throw new Error(`renderExprInfix: not a validated expr node: ${JSON.stringify(node)}`);
}

// A literal that round-trips identically in Java/Python/TypeScript source for every value this
// grammar's own validateDerivedExpr() ever admits (a finite JS number) -- integers print without a
// decimal point in all three (matching each language's own int-literal-as-double/float/number
// promotion), and JS's own Number-to-string conversion already avoids exponential notation for
// every magnitude a real business-rule constant would plausibly use.
function formatConst(value) {
	return String(value);
}

/**
 * Walks an already-validated expr tree and returns every distinct `{ref}` name, in first-appearance
 * (pre-order, left-to-right) order -- this becomes the generated function's own parameter list, so
 * the order must be deterministic and match how a human reading the source rule would expect
 * argument order to fall out.
 */
export function collectParams(node, seen = new Set(), out = []) {
	if (Object.hasOwn(node, 'ref')) {
		if (!seen.has(node.ref)) { seen.add(node.ref); out.push(node.ref); }
		return out;
	}
	if (Object.hasOwn(node, 'const')) return out;
	if (Object.hasOwn(node, 'op')) {
		for (const arg of node.args) collectParams(arg, seen, out);
		return out;
	}
	return out;
}

/**
 * Groups a compiled `derived[]` list into one entry per resource, each provider emits one file
 * per group (a `<Resource>Rules` class/module). Resources sorted alphabetically, rules within a
 * resource sorted by field name -- deterministic and independent of whatever arbitrary order
 * rule ids happened to sort into (`artifact.derived` is sorted by id, not by field).
 *
 * COST, named rather than silently accepted: if two DIFFERENT features both declare a derived
 * rule for the same resource name, each feature's own `rules emit` regenerates that resource's
 * WHOLE file from its own view alone -- whichever feature emits last wins, silently dropping the
 * other feature's methods for that resource. Merging across features would need real cross-
 * feature provenance tracking this slice does not build (no proven need yet -- the same
 * measurement-before-infra discipline `D-javascript-express-adapter` already applied elsewhere).
 * Named here, in every provider's own postEmitNotes, and in DECISIONS.md -- not hidden.
 */
export function groupDerivedByResource(derived) {
	const byResource = new Map();
	for (const rule of derived) {
		if (!byResource.has(rule.resource)) byResource.set(rule.resource, []);
		byResource.get(rule.resource).push(rule);
	}
	return [...byResource.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([resource, rules]) => [resource, rules.slice().sort((a, b) => a.field.localeCompare(b.field))]);
}
