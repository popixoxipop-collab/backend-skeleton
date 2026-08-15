import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const STACK_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function listCatalogChoices() {
	const catalogDir = path.join(STACK_ROOT, 'catalog');
	if (!fs.existsSync(catalogDir)) return [];
	return fs.readdirSync(catalogDir)
		.filter((f) => f.endsWith('.yml'))
		.map((f) => f.replace(/\.yml$/, ''));
}

export function loadCatalogEntry(choiceId) {
	const catalogPath = path.join(STACK_ROOT, 'catalog', `${choiceId}.yml`);
	if (!fs.existsSync(catalogPath)) {
		throw new Error(`unknown stack choice "${choiceId}" -- known choices: ${listCatalogChoices().join(', ') || '(none)'}`);
	}
	return parseYaml(fs.readFileSync(catalogPath, 'utf8'));
}

function renderTemplate(templatePath, vars) {
	let content = fs.readFileSync(templatePath, 'utf8');
	for (const [key, value] of Object.entries(vars)) {
		content = content.replaceAll(`{{${key}}}`, String(value));
	}
	return content;
}

// D7 (DECISIONS.md): a stack choice's static half is entirely data-driven (this catalog entry)
// -- planApply/applyPlan are generic across any catalog entry shaped like schemas/stack-choice.
// schema.json, so "add a stack" is a YAML edit (+ optionally a template), not new glue code.
export function planApply(repoRoot, entry, { port = 8080 } = {}) {
	const plan = { choice: entry.id, alreadyDetected: false, files: [], envExampleActions: [], configChecks: [] };

	const envFile = path.join(repoRoot, '.env');
	const envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
	plan.alreadyDetected = (entry.detect?.files ?? []).some((f) => fs.existsSync(path.join(repoRoot, f)))
		|| (entry.detect?.env_keys ?? []).some((k) => new RegExp(`^${k}=`, 'm').test(envContent));

	for (const f of entry.static?.files ?? []) {
		const templatePath = path.join(STACK_ROOT, f.template);
		const targetPath = path.join(repoRoot, f.path);
		const rendered = renderTemplate(templatePath, { PORT: port });
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
