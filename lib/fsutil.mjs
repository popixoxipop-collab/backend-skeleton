import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function sha256File(filePath) {
	if (!fs.existsSync(filePath)) return null;
	return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
