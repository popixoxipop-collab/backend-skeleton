import { execFileSync } from 'node:child_process';

function git(args, cwd) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function repoRoot(cwd = process.cwd()) {
	try {
		return git(['rev-parse', '--show-toplevel'], cwd);
	} catch {
		return null;
	}
}

export function headSha(cwd = process.cwd()) {
	return git(['rev-parse', 'HEAD'], cwd);
}

// Cheap, local-only re-check of the default branch (no network) -- used to build the
// `preflight` gate's re-verifiable token inputs, NOT as a replacement for the full 3-way
// cross-check scripts/preflight-base-ref.sh does at actual preflight time.
export function localDefaultBranch(cwd = process.cwd()) {
	try {
		return git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd).replace(/^origin\//, '');
	} catch {
		return null;
	}
}
