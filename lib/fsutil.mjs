import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function sha256File(filePath) {
	if (!fs.existsSync(filePath)) return null;
	return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function sha256String(content) {
	return createHash('sha256').update(content).digest('hex');
}

export function readJsonIfExists(filePath) {
	if (!fs.existsSync(filePath)) return null;
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Atomic write (temp + rename), same technique as lib/state.mjs -- reused by every command that
// writes a durable artifact under specs/<feature_id>/ so a mid-write crash can't leave a
// half-written file that a later gate check would treat as valid.
export function writeFileAtomic(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, filePath);
}

// S2: non-throwing sibling of stack/apply.mjs's assertContained() -- same containment check
// (D-security-4's class of defense), but for callers reading a repo-relative path OUT OF untrusted
// JSON (an O2 handles-manifest entry, a stack.json applied_files entry) where "this path escapes
// the repo" should be treated as "not a file we generated" and skipped, not a thrown error that
// would take down a `bskel verify` report over one bad entry.
export function resolveWithinRoot(root, relPath) {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(root, relPath);
	const rel = path.relative(resolvedRoot, resolvedTarget);
	if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
	return resolvedTarget;
}
