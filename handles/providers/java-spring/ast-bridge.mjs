// A2 Phase 2 (D-java-ast-helper): the Node-side bridge to the real JavaParser + Symbol Solver
// helper (ast-helper/) -- invoked only when a human explicitly passes `--ast` to
// `bskel handles plan`, never a hard dependency of the base install, never invoked silently.
// See DECISIONS.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_DIR = path.join(__dirname, 'ast-helper');

function gradlewPath() {
	return path.join(HELPER_DIR, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
}

// Cheap, synchronous -- used by both `bskel doctor` and the `--ast` flag's own upfront check, so
// a missing JDK fails loud with a clear remediation message instead of a confusing subprocess
// error surfacing from deep inside a Gradle invocation.
export function detectAstHelperAvailable() {
	if (!fs.existsSync(gradlewPath())) return { available: false, reason: 'the bundled AST helper (handles/providers/java-spring/ast-helper/) is missing its Gradle wrapper -- this installation may be corrupt' };
	try {
		execFileSync('java', ['-version'], { stdio: 'pipe' });
	} catch {
		return { available: false, reason: 'no `java` found on PATH -- the AST helper needs a JDK (17+) to run. Install one, e.g. via your platform\'s package manager or https://adoptium.net' };
	}
	return { available: true, reason: null };
}

// Async -- spawns the helper's own Gradle wrapper. First invocation on a machine downloads
// JavaParser's own dependency from Maven Central (a real, one-time network access) -- logged
// explicitly here, matching this project's own established "network access must be explicit,
// never silent" precedent (P2's Spring Initializr call).
export async function runAstClassify(dtoFilePath, srcRoot) {
	const detection = detectAstHelperAvailable();
	if (!detection.available) {
		throw new Error(detection.reason);
	}
	if (!fs.existsSync(path.join(HELPER_DIR, 'gradle', 'wrapper', 'gradle-wrapper.jar'))) {
		throw new Error('the bundled AST helper is missing its Gradle wrapper jar -- this installation may be corrupt');
	}
	console.error('bskel: running the AST helper (downloads its own dependencies from Maven Central on first use -- one-time, requires network)...');
	let stdout;
	try {
		({ stdout } = await execFileAsync(gradlewPath(), ['run', '--console=plain', '-q', `--args="${dtoFilePath}" "${srcRoot}"`], {
			cwd: HELPER_DIR,
			maxBuffer: 16 * 1024 * 1024,
		}));
	} catch (err) {
		throw new Error(`AST helper invocation failed: ${err.stderr || err.message}`);
	}
	const jsonLine = stdout.split('\n').find((line) => line.trim().startsWith('{'));
	if (!jsonLine) {
		throw new Error(`AST helper produced no parseable JSON output:\n${stdout}`);
	}
	return JSON.parse(jsonLine);
}
