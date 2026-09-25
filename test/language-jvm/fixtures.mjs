import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'));

if (manifest.schema !== 'bskel.jvm-fixture-manifest/0-draft') {
	throw new Error(`unsupported JVM fixture manifest schema: ${String(manifest.schema)}`);
}

export const JVM_FIXTURES = Object.freeze(manifest.fixtures.map((entry) => {
	if (typeof entry.file !== 'string' || entry.file.startsWith('/') || entry.file.split('/').includes('..')) {
		throw new Error(`unsafe JVM fixture path: ${String(entry.file)}`);
	}
	const absolute = path.resolve(FIXTURE_ROOT, entry.file);
	if (absolute !== FIXTURE_ROOT && !absolute.startsWith(`${FIXTURE_ROOT}${path.sep}`)) {
		throw new Error(`JVM fixture escapes fixture root: ${entry.file}`);
	}
	return Object.freeze({
		...entry,
		path: `test/language-jvm/fixtures/${entry.file}`,
		source: fs.readFileSync(absolute, 'utf8'),
	});
}));

export function jvmFixture(id) {
	const fixture = JVM_FIXTURES.find((item) => item.id === id);
	if (!fixture) throw new Error(`unknown JVM fixture: ${id}`);
	return fixture;
}
