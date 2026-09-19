// A2 Phase 2 (D-java-ast-helper): the Node-side bridge to the real JavaParser + Symbol Solver
// helper (ast-helper/) -- invoked only when a human explicitly passes `--ast` to
// `bskel handles plan`, never a hard dependency of the base install, never invoked silently.
// See DECISIONS.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

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

// D-java-source-splice: writes `locators` (each {type_fqn, member_kind, member_name,
// erased_param_types}) to a scratch temp file in the plain, delimiter-free line format
// Main.java's readLocators() expects (deliberately not JSON -- the helper has no JSON parser
// dependency and none of these fields can ever contain a newline), invokes the helper's new
// "locate" mode, and returns its parsed `{topLevelTypes, results}`. The temp file is always
// removed, even on failure.
export async function runAstLocate(javaFilePath, srcRoot, locators) {
	const detection = detectAstHelperAvailable();
	if (!detection.available) {
		throw new Error(detection.reason);
	}
	const lines = [String(locators.length)];
	for (const loc of locators) {
		lines.push(loc.type_fqn, loc.member_kind, loc.member_name, String((loc.erased_param_types ?? []).length));
		for (const p of loc.erased_param_types ?? []) lines.push(p);
	}
	const tmpFile = path.join(os.tmpdir(), `bskel-ast-locators-${randomUUID()}.txt`);
	fs.writeFileSync(tmpFile, `${lines.join('\n')}\n`);
	try {
		console.error('bskel: running the AST helper (locate mode)...');
		let stdout;
		try {
			({ stdout } = await execFileAsync(
				gradlewPath(),
				['run', '--console=plain', '-q', `--args="locate" "${javaFilePath}" "${srcRoot}" "${tmpFile}"`],
				{ cwd: HELPER_DIR, maxBuffer: 16 * 1024 * 1024 },
			));
		} catch (err) {
			throw new Error(`AST helper (locate) invocation failed: ${err.stderr || err.message}`);
		}
		const jsonLine = stdout.split('\n').find((line) => line.trim().startsWith('{'));
		if (!jsonLine) {
			throw new Error(`AST helper (locate) produced no parseable JSON output:\n${stdout}`);
		}
		return JSON.parse(jsonLine);
	} finally {
		fs.rmSync(tmpFile, { force: true });
	}
}

// D-java-source-splice: a plain syntax gate for RENDERED content that has not been written to
// disk yet -- the helper's "parse -" mode reads `sourceText` from stdin (no temp file, no
// classpath/src-root needed at all for a syntax-only check) and returns {ok:true} or
// {ok:false, problems:[...]}. Uses `spawn` directly, NOT the promisified `execFile` used
// elsewhere in this file -- confirmed live that Node's async execFile has no `input` option at
// all (only execFileSync does); passing one is silently ignored and the child process hangs
// reading from this process's OWN inherited stdin instead of the string ever intended for it.
export async function runAstParse(sourceText) {
	const detection = detectAstHelperAvailable();
	if (!detection.available) {
		throw new Error(detection.reason);
	}
	return new Promise((resolve, reject) => {
		const child = spawn(gradlewPath(), ['run', '--console=plain', '-q', '--args="parse" "-"'], {
			cwd: HELPER_DIR,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => { stdout += d; });
		child.stderr.on('data', (d) => { stderr += d; });
		child.on('error', (err) => reject(new Error(`AST helper (parse) invocation failed: ${err.message}`)));
		child.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`AST helper (parse) invocation failed (exit ${code}): ${stderr || stdout}`));
				return;
			}
			const jsonLine = stdout.split('\n').find((line) => line.trim().startsWith('{'));
			if (!jsonLine) {
				reject(new Error(`AST helper (parse) produced no parseable JSON output:\n${stdout}`));
				return;
			}
			try {
				resolve(JSON.parse(jsonLine));
			} catch (err) {
				reject(new Error(`AST helper (parse) produced unparseable JSON: ${err.message}\n${stdout}`));
			}
		});
		child.stdin.write(sourceText);
		child.stdin.end();
	});
}
