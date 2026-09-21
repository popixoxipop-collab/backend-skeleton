import fs from 'node:fs';
import path from 'node:path';

// The Windows system `bash.exe` is normally the WSL launcher.  Invoking a
// repository-local shell script through its shebang can therefore start WSL
// (or hang while WSL initializes) instead of the Git for Windows Bash that
// ships alongside the required `git` executable.  Keep this decision in one
// small, testable module so the CLI and the shell-script integration tests
// execute the same runner.
export function resolvePreflightRunner({
	platform = process.platform,
	env = process.env,
	exists = fs.existsSync,
} = {}) {
	if (platform !== 'win32') return null;

	const programFiles = env.ProgramFiles || 'C:\\Program Files';
	const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
	const candidates = [
		env.BSKEL_BASH,
		path.join(programFiles, 'Git', 'bin', 'bash.exe'),
		path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
		path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
	].filter(Boolean);

	const bashPath = candidates.find((candidate) => exists(candidate));
	return bashPath ? { command: bashPath, argsPrefix: [] } : null;
}

