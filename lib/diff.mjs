// D-patch-transactions: promoted verbatim from handles/_engine.mjs (D4/D-handles-dryrun's own
// unifiedDiff()) -- pure code motion, zero behavior change. Generic enough that stack/config-apply.
// mjs needs the identical mechanism for its own collateral-diff safety gate, and there was no
// existing stack <-> handles import in either direction to introduce by leaving it where it was.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// D4 (D-handles-dryrun): a real unified diff via `git diff --no-index`, not a hand-rolled diff
// algorithm -- `git` is already a hard dependency elsewhere in this codebase, so this adds zero
// new dependencies. `cwd: tmpDir` + relative `a/<relPath>`/`b/<relPath>` paths (rather than
// absolute temp paths) keep the diff header clean and reproducible -- the random tmpdir name
// never leaks into the output. `git diff --no-index` exits 1 when the two sides differ (the
// expected, common case here, not a failure) -- only a status other than 0/1 is a genuine error
// worth throwing.
export function unifiedDiff(relPath, before, after) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-diff-'));
	try {
		const beforeAbs = path.join(tmpDir, 'a', relPath);
		const afterAbs = path.join(tmpDir, 'b', relPath);
		fs.mkdirSync(path.dirname(beforeAbs), { recursive: true });
		fs.mkdirSync(path.dirname(afterAbs), { recursive: true });
		fs.writeFileSync(beforeAbs, before ?? '');
		fs.writeFileSync(afterAbs, after ?? '');
		try {
			return execFileSync('git', ['diff', '--no-index', '--no-color', '--', `a/${relPath}`, `b/${relPath}`], { cwd: tmpDir, encoding: 'utf8' });
		} catch (err) {
			if (err.status === 1 && typeof err.stdout === 'string') return err.stdout;
			throw err;
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}
