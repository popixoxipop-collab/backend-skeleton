import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function sha256File(filePath) {
	if (!fs.existsSync(filePath)) return null;
	return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// S6 (D-verify-integrity): sha256File's own permission-bit sibling -- content hashing is
// deliberately blind to a chmod-only change (bytes are unchanged), so a gate that wants to notice
// e.g. an executable script losing its executable bit needs a separate fingerprint. Same
// null-means-missing convention as sha256File, for the same reason (a caller checking gate
// staleness treats "gone" and "changed" the same way).
export function fileMode(filePath) {
	if (!fs.existsSync(filePath)) return null;
	return (fs.statSync(filePath).mode & 0o777).toString(8);
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
// D-gate-attestation-signing: `mode` is additive and optional (undefined -> Node's own default
// mode-minus-umask, byte-for-byte the same behavior every existing caller already gets) -- added
// so a sensitive file (a private signing key) can be created with a restrictive mode from its
// very first write, rather than a separate chmod() after the fact leaving a real, if brief,
// window where the file exists at the default (world/group-readable) permissions.
export function writeFileAtomic(filePath, content, mode) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
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
