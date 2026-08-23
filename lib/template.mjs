// P2b (D-greenfield-parameters): the `{{VAR}}` substitution `stack/apply.mjs` has performed since
// D7 and `new/fastapi.mjs` performed as a one-variable special case (`text.replaceAll('{{SLUG}}',
// slug)`), extracted verbatim so both consume ONE implementation. Pure code motion -- the loop body
// below is character-for-character what `stack/apply.mjs::renderTemplate()` ran before, which is why
// `test/stack-cli.test.mjs` passes completely unmodified across this extraction (the same bar
// `D-handles-providers`' own extraction met). Same precedent as `scanners/text-util.mjs` and
// `scanners/adapters/_express-shared.mjs`: a helper two real call sites already duplicate gets its
// own module, rather than a third private copy.
import fs from 'node:fs';

// P4 (D-extension-conformance) originally defined this inside `bin/bskel.mjs` for `catalog lint`.
// It moved here when P2b gave it a second consumer: `new/fastapi.mjs` runs it over every rendered
// file and fails the scaffold CLOSED, which is coverage `new/templates/**` never had (the P4 lint
// only ever looked at `stack/catalog/`). Deliberately the SAME regex, not a similar one -- a
// template variable this project's own renderer would never substitute looks identical whichever
// template tree it is sitting in.
export const RESIDUAL_TEMPLATE_VAR_RE = /\{\{[A-Z_][A-Z0-9_]*\}\}/g;

export function renderTemplateText(text, vars) {
	let content = text;
	for (const [key, value] of Object.entries(vars)) {
		content = content.replaceAll(`{{${key}}}`, String(value));
	}
	return content;
}

export function renderTemplateFile(templatePath, vars) {
	return renderTemplateText(fs.readFileSync(templatePath, 'utf8'), vars);
}

// De-duplicated, in first-appearance order -- callers report these to a human, and the same
// unfilled token appearing four times in one file is one problem, not four.
export function findResidualTemplateVars(text) {
	return [...new Set(text.match(RESIDUAL_TEMPLATE_VAR_RE) ?? [])];
}
