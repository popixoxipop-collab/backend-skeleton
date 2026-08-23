import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
// P2b (D-greenfield-parameters): was a private `renderTemplate(templatePath, vars)` here, moved to
// lib/template.mjs unchanged once `new/fastapi.mjs` became its second real consumer.
import { renderTemplateFile } from '../lib/template.mjs';

const STACK_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_ROOT = path.join(STACK_ROOT, '..', 'schemas');

// D-security-4: `choiceId` must be a bare identifier, never a path. Found by the Codex security
// review: `path.join(STACK_ROOT, 'catalog', choiceId + '.yml')` with an unvalidated choiceId
// lets `--choice ../../../../whatever` escape the catalog dir entirely.
const CHOICE_ID_RE = /^[a-z][a-z0-9-]*$/;

export function listCatalogChoices() {
	const catalogDir = path.join(STACK_ROOT, 'catalog');
	if (!fs.existsSync(catalogDir)) return [];
	return fs.readdirSync(catalogDir)
		.filter((f) => f.endsWith('.yml'))
		.map((f) => f.replace(/\.yml$/, ''));
}

// Resolves `target` and asserts it stays within `root` -- used for both catalog-entry template
// paths (must stay under STACK_ROOT) and generated-file target paths (must stay under the
// caller's repoRoot). A catalog entry is data (currently only ships with this skill, but the
// mechanism doesn't assume that), so every path it names is treated as untrusted input.
function assertContained(root, target, label) {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	const rel = path.relative(resolvedRoot, resolvedTarget);
	if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		throw new Error(`${label} "${target}" escapes "${root}" -- refusing (possible path traversal in a stack catalog entry)`);
	}
}

let _ajv = null;
function ajv() {
	if (!_ajv) _ajv = new Ajv2020({ allErrors: true, strict: false });
	return _ajv;
}

function loadStackChoiceSchema() {
	return JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, 'stack-choice.schema.json'), 'utf8'));
}

export function loadCatalogEntry(choiceId) {
	if (!CHOICE_ID_RE.test(choiceId)) {
		throw new Error(`invalid stack choice "${choiceId}" -- must match ${CHOICE_ID_RE} (known choices: ${listCatalogChoices().join(', ') || '(none)'})`);
	}
	const catalogPath = path.join(STACK_ROOT, 'catalog', `${choiceId}.yml`);
	assertContained(path.join(STACK_ROOT, 'catalog'), catalogPath, 'catalog entry path');
	if (!fs.existsSync(catalogPath)) {
		throw new Error(`unknown stack choice "${choiceId}" -- known choices: ${listCatalogChoices().join(', ') || '(none)'}`);
	}
	const entry = parseYaml(fs.readFileSync(catalogPath, 'utf8'));

	const schema = loadStackChoiceSchema();
	const validateFn = ajv().getSchema(schema.$id) ?? ajv().compile(schema);
	if (!validateFn(entry)) {
		const details = (validateFn.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
		throw new Error(`catalog entry "${choiceId}.yml" does not match schemas/stack-choice.schema.json: ${details}`);
	}
	return entry;
}

// D7 (DECISIONS.md): a stack choice's static half is entirely data-driven (this catalog entry)
// -- planApply/applyPlan are generic across any catalog entry shaped like schemas/stack-choice.
// schema.json, so "add a stack" is a YAML edit (+ optionally a template), not new glue code.
export function planApply(repoRoot, entry, { port = 8080 } = {}) {
	const plan = { choice: entry.id, alreadyDetected: false, files: [], envExampleActions: [], configChecks: [] };

	// D-security-6: never read the target repo's .env, even for a read-only dry-run detection
	// check. This project's own convention (D-security-6 in DECISIONS.md) and the target repo's CLAUDE.md
	// both say the agent doesn't read/edit .env -- only a human-invoked runtime bootstrap script
	// does. Detection now relies solely on `detect.files` (e.g. does scripts/dev-tunnel.sh
	// already exist), which is what the ngrok catalog entry primarily uses anyway. Found by the
	// Codex security review (a dry-run reading the full .env, even without printing it, still
	// crossed the stated boundary).
	plan.alreadyDetected = (entry.detect?.files ?? []).some((f) => fs.existsSync(path.join(repoRoot, f)));

	for (const f of entry.static?.files ?? []) {
		const templatePath = path.join(STACK_ROOT, f.template);
		assertContained(STACK_ROOT, templatePath, 'catalog template path');
		const targetPath = path.join(repoRoot, f.path);
		assertContained(repoRoot, targetPath, 'catalog target path');
		const rendered = renderTemplateFile(templatePath, { PORT: port });
		const exists = fs.existsSync(targetPath);
		const unchanged = exists && fs.readFileSync(targetPath, 'utf8') === rendered;
		plan.files.push({
			path: f.path,
			mode: f.mode ?? null,
			action: !exists ? 'create' : (unchanged ? 'unchanged' : 'update'),
			content: rendered,
		});
	}

	const envExamplePath = path.join(repoRoot, '.env.example');
	const existingEnvExample = fs.existsSync(envExamplePath) ? fs.readFileSync(envExamplePath, 'utf8') : '';
	for (const e of entry.static?.env_example ?? []) {
		const already = new RegExp(`^${e.key}=`, 'm').test(existingEnvExample);
		plan.envExampleActions.push({
			key: e.key, doc: e.doc, required: Boolean(e.required), secret: Boolean(e.secret),
			action: already ? 'unchanged' : 'append',
		});
	}

	for (const c of entry.static?.config_check ?? []) {
		const targetPath = path.join(repoRoot, c.target);
		assertContained(repoRoot, targetPath, 'catalog config_check target path');
		let status = 'target-missing';
		if (fs.existsSync(targetPath)) {
			status = new RegExp(c.externalized_pattern).test(fs.readFileSync(targetPath, 'utf8'))
				? 'already-externalized'
				: 'needs-manual-patch';
		}
		plan.configChecks.push({ target: c.target, status, note: c.note });
	}

	return plan;
}

// D-config-patch: config_check is informational ONLY -- backend-skeleton never auto-edits an
// application config file. WHY: the target config (e.g. Spring's application.yaml) is often
// comment-dense and hand-tuned; a wrong automatic edit there is a worse failure mode than
// asking a human to add one line. COST: a `needs-manual-patch` status requires a human step.
// EXIT: if a safe, comment-preserving patcher is built later (the `yaml` package's Document
// API supports this), config_check could gain an `apply` action -- not built now because the
// real target (Team-IZ-Backend) doesn't need it (already externalized), so there's no concrete
// case to validate a patcher against yet.
export function applyPlan(repoRoot, plan) {
	const written = [];
	for (const f of plan.files) {
		if (f.action === 'unchanged') continue;
		const targetPath = path.join(repoRoot, f.path);
		// Re-asserted here too (planApply already checked it) -- applyPlan must not assume it's
		// only ever called with a plan it just generated for the same repoRoot.
		assertContained(repoRoot, targetPath, 'catalog target path');
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.writeFileSync(targetPath, f.content);
		if (f.mode) fs.chmodSync(targetPath, Number.parseInt(f.mode, 8));
		written.push(f.path);
	}

	const toAppend = plan.envExampleActions.filter((a) => a.action === 'append');
	if (toAppend.length > 0) {
		const envExamplePath = path.join(repoRoot, '.env.example');
		let addition = fs.existsSync(envExamplePath) ? '' : '# Environment variables -- copy relevant ones into your own .env.\n\n';
		for (const a of toAppend) {
			addition += `# ${a.doc}${a.required ? ' (required)' : ' (optional)'}\n${a.key}=\n\n`;
		}
		fs.appendFileSync(envExamplePath, addition);
		written.push('.env.example');
	}

	return written;
}
