// P2 (D-greenfield-bootstrap): unlike Spring, FastAPI has no first-party scaffolding CLI/service
// with comparable official standing to Spring Initializr (confirmed while researching this item)
// -- so "pinned starter" here means a minimal, LOCAL, hand-written template matching the exact
// layout scanners/adapters/python-fastapi.mjs's own detectPythonFastApiRoot() already expects
// (a pyproject.toml declaring a `fastapi` dependency + a .py file that imports/instantiates it),
// not a third-party generator. No network call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates', 'fastapi');

function renderTemplate(text, slug) {
	return text.replaceAll('{{SLUG}}', slug);
}

function copyDir(srcDir, destDir, slug) {
	fs.mkdirSync(destDir, { recursive: true });
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		const srcPath = path.join(srcDir, entry.name);
		if (entry.isDirectory()) {
			copyDir(srcPath, path.join(destDir, entry.name), slug);
			continue;
		}
		// The template's own gitignore is named without a leading dot (see new/templates/fastapi/
		// gitignore) so this repo's own tooling never treats it as a real, active .gitignore.
		const destName = entry.name === 'gitignore' ? '.gitignore' : entry.name;
		fs.writeFileSync(path.join(destDir, destName), renderTemplate(fs.readFileSync(srcPath, 'utf8'), slug));
	}
}

export async function scaffoldFastapi({ dir, slug }) {
	if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
		throw new Error(`${dir} already exists and is not empty -- refusing to scaffold into it`);
	}
	copyDir(TEMPLATE_DIR, dir, slug);
	return { dir };
}
