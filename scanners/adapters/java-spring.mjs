// Ripgrep-for-discovery + a masking/balanced-delimiter structural scan (A2 Phase 1,
// D-java-analyzer -- see scanners/adapters/_java-spring-analyzer.mjs) for structure. Deliberately
// still no real Java parser/AST (Phase 2, out of scope) -- good enough to find "does a related
// module already exist" without a compiler dependency, not a general-purpose Java analyzer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lineNumberAt, listRgFiles, byShallowestThenName } from '../text-util.mjs';
import { maskNonCode, findClassOrRecordDeclaration, findClassLevelMappingArgs, findMappingAnnotations } from './_java-spring-analyzer.mjs';

const JAVA_BUILD_FILE_GLOBS = ['build.gradle', 'build.gradle.kts', 'pom.xml'];

// D-cross-adapter-root-detection: until now, the ONLY one of this project's 4 real adapters whose
// detect() assumed repoRoot itself was the project root -- python-fastapi.mjs/typescript-express.mjs/
// javascript-express.mjs each already walk the WHOLE repo for their own project marker file
// (python-fastapi.mjs's own comment names the exact reason: "a real target [oracle] is a monorepo
// whose FastAPI project lives under backend/"). A Spring project nested the same way (e.g.
// backend-java/build.gradle in a polyglot monorepo) was silently invisible to this adapter --
// found live by direct comparison of all 4 adapters' detect() functions, not anticipated
// defensively. `runScan()`'s specificity-based arbitration (see scanners/index.mjs and
// python-fastapi.mjs's own specificity comment) already handles the "two adapters both detect the
// same repoRoot" case deterministically; this fix addresses the OTHER failure mode -- a real
// Spring project going completely undetected and silently falling through to generic-grep.
//
// Every candidate build file is tried in turn, shallowest first, not just the first one found
// (unlike python-fastapi's single-candidate check) -- a real multi-module Gradle project's ROOT
// build.gradle is routinely just an aggregator (`subprojects { ... }`) with no src/main/java of
// its own; the actual source lives under a child module's own build.gradle. Same two-signal bar
// as before either way: a build file AND a sibling src/main/java, both required.
export function detectJavaSpringRoot(repoRoot) {
	const buildFiles = listRgFiles(repoRoot, JAVA_BUILD_FILE_GLOBS).sort(byShallowestThenName);
	for (const buildFile of buildFiles) {
		const srcRoot = path.join(path.dirname(buildFile), 'src', 'main', 'java');
		if (fs.existsSync(srcRoot)) return srcRoot;
	}
	return null;
}

// O6: `rg --files` (no `--sort`) is explicitly unordered/parallel by ripgrep's own docs -- two
// runs against an unchanged repo can return files in a different order, which without this sort
// would propagate into non-deterministic controller/entity/module array order in every scan
// report and contract, causing spurious diffs even when nothing real changed.
function listJavaFiles(srcRoot) {
	const out = execFileSync('rg', ['--files', '-g', '*.java', srcRoot], { encoding: 'utf8' });
	return out.split('\n').filter(Boolean).sort();
}

function moduleOf(filePath, srcRoot) {
	const parts = path.relative(srcRoot, filePath).split(path.sep);
	const domainIdx = parts.indexOf('domain');
	return domainIdx >= 0 && parts[domainIdx + 1] ? parts[domainIdx + 1] : null;
}

function extractQuotedOrValue(argsText) {
	if (argsText == null) return null;
	const named = argsText.match(/value\s*=\s*"([^"]*)"/);
	if (named) return named[1];
	const bare = argsText.match(/"([^"]*)"/);
	return bare ? bare[1] : null;
}

function joinPath(base, segment) {
	const b = (base || '').replace(/\/$/, '');
	const s = (segment || '').replace(/^\//, '');
	return s ? `${b}/${s}` : (b || '/');
}

// A2 Phase 1 (D-java-analyzer): finds every `operationId = "..."` occurrence's REAL value within
// `text[searchStart:searchEnd]`, safe from a comment/string phantom match (D-java-analyzer's
// headline example: a `//` comment mentioning `operationId = "..."` as prose used to appear in
// controller.operationIds). The POSITION is found on `masked` text (comments/strings blanked to
// spaces, so a phantom mention can never be found there at all); the VALUE is always re-read from
// the ORIGINAL text at that same offset, since a masked string body only ever contains spaces.
function findOperationIdValue(text, masked, searchStart, searchEnd) {
	const posMatch = masked.slice(searchStart, searchEnd).match(/operationId\s*=\s*"/);
	if (!posMatch) return null;
	const real = text.slice(searchStart + posMatch.index).match(/operationId\s*=\s*"([^"]+)"/);
	return real ? real[1] : null;
}

function findAllOperationIdValues(text, masked) {
	const ids = [];
	const re = /operationId\s*=\s*"/g;
	let m;
	while ((m = re.exec(masked))) {
		const real = text.slice(m.index).match(/operationId\s*=\s*"([^"]+)"/);
		if (real) ids.push(real[1]);
	}
	return ids;
}

function extractController(text, filePath) {
	if (!/@RestController\b/.test(text)) return null;
	const masked = maskNonCode(text);

	// D3 (D-scanner-evidence): the class declaration's own line -- classLine is null only when
	// there's no class/record declaration at all to point at.
	const classDecl = findClassOrRecordDeclaration(masked);
	const className = classDecl ? classDecl.name : path.basename(filePath, '.java');
	const classLine = classDecl ? lineNumberAt(text, classDecl.index) : null;

	// A2 Phase 1: class-level @RequestMapping detection now goes through the shared analyzer
	// (balanced-paren args, masked-text lookahead for `class`/`record`) instead of a lazy-backtrack
	// regex -- see D-java-analyzer for the lazy-backtrack misattribution bug this class of pattern
	// used to cause.
	const classMappingArgs = findClassLevelMappingArgs(text);
	const basePath = classMappingArgs != null ? (extractQuotedOrValue(classMappingArgs) ?? '') : '';

	// Document-order list of every operationId in the file -- this is what the acceptance
	// oracle (10 operationIds for Team-IZ-Backend's OrganizationController) checks directly.
	const operationIds = findAllOperationIdValues(text, masked);
	const operationStarts = [...masked.matchAll(/@Operation\(/g)].map((m) => m.index);

	const endpoints = [];
	for (const mapping of findMappingAnnotations(text)) {
		const segment = extractQuotedOrValue(mapping.argsText) ?? '';

		// Correlate with the nearest PRECEDING @Operation( block, even when an @ApiResponses
		// (or similar) annotation sits between it and this mapping -- heuristic, not a parser.
		let operationId = null;
		const preceding = operationStarts.filter((idx) => idx < mapping.index);
		if (preceding.length > 0) {
			operationId = findOperationIdValue(text, masked, preceding[preceding.length - 1], mapping.index);
		}
		// D3: line of the mapping annotation itself. A2 Phase 1: this is now the SAME position
		// handles/providers/java-spring/plan.mjs derives too -- both consume
		// findMappingAnnotations() from scanners/adapters/_java-spring-analyzer.mjs, the duplicate
		// regex pass this comment used to point at is gone.
		endpoints.push({ verb: mapping.verb, path: joinPath(basePath, segment), operationId, method: mapping.methodName, line: mapping.methodLine });
	}

	return { className, basePath, operationIds, endpoints, file: filePath, line: classLine };
}

function extractEntity(text, filePath) {
	if (!/@Entity\b/.test(text)) return null;
	const masked = maskNonCode(text);
	const classDecl = findClassOrRecordDeclaration(masked);
	const tableMatch = text.match(/@Table\(\s*name\s*=\s*"([^"]+)"/);
	const idFieldMatch = text.match(/@Id\b[\s\S]{0,200}?private\s+\S+\s+(\w+)\s*;/);
	return {
		className: classDecl ? classDecl.name : path.basename(filePath, '.java'),
		table: tableMatch ? tableMatch[1] : null,
		idField: idFieldMatch ? idFieldMatch[1] : null,
		file: filePath,
		line: classDecl ? lineNumberAt(text, classDecl.index) : null,
	};
}

function extractDomainEnum(text, filePath) {
	const match = text.match(/public\s+enum\s+(\w+)\s*\{([\s\S]*?)\n\}/);
	if (!match) return null;
	const [, name, rawBody] = match;
	const body = maskNonCode(rawBody);
	// Each constant ends at the first `,` `;` (or the start of a constructor-arg `(` if present).
	const constants = body
		.split(/[,;]/)
		.map((s) => s.trim().split('(')[0].trim())
		.filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s));
	return { name, constants, file: filePath, line: lineNumberAt(text, match.index) };
}

const APPLICATION_CONFIG_GLOB = 'application*.{yml,yaml,properties}';

function findApplicationConfigFiles(repoRoot) {
	try {
		return execFileSync('rg', ['--files', '-g', APPLICATION_CONFIG_GLOB, repoRoot], { encoding: 'utf8' })
			.split('\n').filter(Boolean).sort(); // O6: rg --files order isn't guaranteed -- see listJavaFiles.
	} catch {
		return []; // rg exits 1 on "no files matched" -- not an error, just nothing to report
	}
}

// A1 §7: three independent Spring config signals for a GLOBAL path prefix the regex endpoint
// scanner structurally cannot see -- extractController() reads one file at a time and has no
// idea a WebMvcConfigurer or application.yaml elsewhere in the repo prepends something to every
// path it found. Team-IZ-Backend's ApiPathConfig.java (configurePathMatch + addPathPrefix) is
// exactly the real defect D-openapi-reconciliation documents: every contract path this tool
// emits without --openapi-file was silently wrong until A1 closed it with real-document
// reconciliation. This function can't fix that (only a real OpenAPI document can) -- it exists
// so a user who doesn't know --openapi-file exists gets told the defect is likely present, via
// scanners/index.mjs's `unknowns` note.
export function detectGlobalPathPrefixSignals(repoRoot) {
	const signals = [];

	// (1) WebMvcConfigurer.configurePathMatch + addPathPrefix("...", ...). Two-step, same style
	// as listJavaFiles/extractController elsewhere in this file: `rg -l` finds candidate FILES
	// mentioning configurePathMatch, then a content read confirms addPathPrefix( is actually
	// present (a configurePathMatch override that does something else entirely -- a custom
	// PathMatcher, a trailing-slash setting -- must not be reported as a prefix).
	// D-cross-adapter-root-detection: reuses detectJavaSpringRoot() rather than re-deriving
	// `path.join(repoRoot, 'src', 'main', 'java')` independently -- the latter was a SECOND place
	// this file assumed repoRoot itself was the project root, found alongside the same bug in
	// detectJavaSpringRoot() itself.
	const srcRoot = detectJavaSpringRoot(repoRoot);
	if (srcRoot) {
		let candidates = [];
		try {
			candidates = execFileSync('rg', ['-l', 'configurePathMatch', '-g', '*.java', srcRoot], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
		} catch {
			// no matches -- not an error
		}
		for (const file of candidates) {
			const text = fs.readFileSync(file, 'utf8');
			const prefixMatch = text.match(/addPathPrefix\s*\(\s*"([^"]+)"/);
			if (!prefixMatch) continue;
			signals.push({ kind: 'configurePathMatch', file: path.relative(repoRoot, file), prefix: prefixMatch[1] });
		}
	}

	// (2)/(3) application.yml/.yaml/.properties -- server.servlet.context-path (Spring Boot's own
	// built-in global-prefix mechanism, same blind spot as (1)) and springdoc.paths-to-match
	// (doesn't itself apply a prefix, but a pattern narrower than "/**" is strong circumstantial
	// evidence one is documented, even when (1)/(2) are what actually implement it). Same
	// good-enough-regex-not-a-real-YAML-parser philosophy as the rest of this file -- matches
	// either YAML (`key:`) or properties (`a.b.c=`) form.
	for (const file of findApplicationConfigFiles(repoRoot)) {
		const text = fs.readFileSync(file, 'utf8');
		const contextPath = text.match(/(?:^|\n)\s*context-path\s*:\s*(\S+)/) ?? text.match(/server\.servlet\.context-path\s*=\s*(\S+)/);
		if (contextPath) {
			signals.push({ kind: 'context-path', file: path.relative(repoRoot, file), prefix: contextPath[1].replace(/^["']|["']$/g, '') });
		}
		const pathsToMatch = text.match(/(?:^|\n)\s*paths-to-match\s*:\s*(\S+)/) ?? text.match(/springdoc\.paths-to-match\s*=\s*(\S+)/);
		if (pathsToMatch) {
			signals.push({ kind: 'paths-to-match', file: path.relative(repoRoot, file), pattern: pathsToMatch[1].replace(/^["']|["']$/g, '') });
		}
	}

	return signals;
}

export function scanJavaSpring(repoRoot) {
	const srcRoot = detectJavaSpringRoot(repoRoot);
	if (!srcRoot) return null;

	const modules = new Map();
	const moduleEntry = (name) => {
		const key = name ?? '_unknown';
		if (!modules.has(key)) modules.set(key, { module: key, controllers: [], entities: [], enums: [], dtos: [] });
		return modules.get(key);
	};

	for (const file of listJavaFiles(srcRoot)) {
		const text = fs.readFileSync(file, 'utf8');
		const mod = moduleOf(file, srcRoot);

		if (/@RestController\b/.test(text)) {
			const controller = extractController(text, file);
			if (controller) moduleEntry(mod).controllers.push(controller);
		}
		if (/@Entity\b/.test(text)) {
			const entity = extractEntity(text, file);
			if (entity) moduleEntry(mod).entities.push(entity);
		}
		if (mod && file.includes(`${path.sep}domain${path.sep}`) && /public\s+enum\s+\w+/.test(text)) {
			const en = extractDomainEnum(text, file);
			if (en) moduleEntry(mod).enums.push(en);
		}
		if (mod && file.includes(`${path.sep}presentation${path.sep}dto${path.sep}`)) {
			moduleEntry(mod).dtos.push({ className: path.basename(file, '.java'), file });
		}
	}

	// S2 (D-gate-precision, continued): repo-relative (not srcRoot-relative like moduleOf's own
	// paths) -- this is what lib/gate-definitions.mjs's `scan` gate hashes to detect real content
	// drift, and every other manifest-shaped gate input in this codebase (stack's `applied_file:`)
	// is repo-relative too.
	const filesRead = listJavaFiles(srcRoot).map((f) => path.relative(repoRoot, f));
	return { srcRoot, modules: [...modules.values()], pathPrefixSignals: detectGlobalPathPrefixSignals(repoRoot), filesRead };
}

// G1: adapter descriptor consumed by scanners/registry.mjs -- see D-adapter-registry in
// DECISIONS.md. Wraps the functions above without changing any of them; `id` must equal this
// file's stem ("java-spring"). specificity 100: this adapter only detects when a Spring Boot
// build file AND src/main/java both exist -- a build-file-plus-source-layout-confirmed match, the
// strongest signal any adapter in this codebase can give.
export const adapter = {
	contract: 'sbf.adapter/2',
	id: 'java-spring',
	title: 'Java / Spring Boot',
	specificity: 100,
	confidence: 'high',
	// D-adapter-verification-basis: the whole A1-A12 OpenAPI-passthrough line, plus O1-O6's
	// handles codegen, was verified against a real production Spring Boot repo (Team-IZ-Backend) --
	// the strongest basis any adapter in this codebase has.
	verificationBasis: 'production-repo',
	capabilities: {
		'api.operations': true,
		'api.request-shape': true,
		'resource.fetch': true,
		'codegen.handles': true,
	},
	detect: detectJavaSpringRoot,
	scan(repoRoot, _detection) {
		const result = scanJavaSpring(repoRoot);
		return { modules: result.modules, pathPrefixSignals: result.pathPrefixSignals, filesRead: result.filesRead };
	},
	// S2 (D-gate-precision, continued): reuses the EXACT same listJavaFiles() call scan() itself
	// makes -- no separate file-walking logic -- so the `scan` gate's staleness token can re-derive
	// the CURRENT read-set fresh every time it's checked (not just re-hash whatever the last scan
	// run happened to record), which is what lets it notice a brand-new file too, not just an edit
	// to a previously-known one.
	listReadSet(repoRoot) {
		const srcRoot = detectJavaSpringRoot(repoRoot);
		if (!srcRoot) return [];
		return listJavaFiles(srcRoot).map((f) => path.relative(repoRoot, f));
	},
	diagnostics(repoRoot) {
		const messages = [];
		// D-cross-adapter-root-detection: recursive now (matches detectJavaSpringRoot() itself),
		// not repoRoot-only -- these two checks used to have their own private, repoRoot-only copy
		// of the same signals detectJavaSpringRoot() computes, which is exactly what let the
		// underlying bug (a nested build.gradle going undetected) hide from `bskel doctor` too.
		const buildFiles = listRgFiles(repoRoot, JAVA_BUILD_FILE_GLOBS);
		if (buildFiles.length === 0) {
			messages.push({ level: 'info', code: 'no-build-file', message: `none of ${JAVA_BUILD_FILE_GLOBS.join(', ')} found anywhere in the repo` });
		}
		const srcRoot = detectJavaSpringRoot(repoRoot);
		if (!srcRoot) {
			messages.push({ level: 'info', code: 'no-src-main-java', message: buildFiles.length > 0 ? 'found a build file, but none has a sibling src/main/java' : 'src/main/java does not exist' });
		} else {
			let rgOk = true;
			try {
				execFileSync('rg', ['--version'], { stdio: 'pipe' });
			} catch {
				rgOk = false;
			}
			if (!rgOk) {
				messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter shells out to it and will throw, not degrade, if it is missing' });
			}
		}
		// D-openapi-extraction-hint: `contract emit --openapi-file` (A1-A12) is where real accuracy
		// comes from for this adapter (path/schema/parameter/security correction, not just the
		// name-heuristic fallback) -- most useful before that flag has ever been used, hence
		// `level: 'info'`, not a warning. If springdoc-openapi is on the classpath: with the Gradle
		// plugin (`org.springdoc.openapi-gradle-plugin`) configured, `./gradlew generateOpenApiDocs`
		// boots the app briefly and writes build/api-docs.json without a human ever starting/curling
		// a server by hand -- this repo's own real Team-IZ-Backend oracle file was produced exactly
		// this way. Without that plugin, the only way is to actually run the app and capture its
		// live /v3/api-docs endpoint -- named honestly as manual, not hidden behind vague language.
		messages.push({
			level: 'info', code: 'openapi-extraction-hint',
			message: 'for real schema/path accuracy, pass --openapi-file to `contract emit`. If springdoc-openapi is on the classpath: with the Gradle plugin (org.springdoc.openapi-gradle-plugin) configured, `./gradlew generateOpenApiDocs` writes build/api-docs.json without running the app by hand; otherwise, run the app and capture its live /v3/api-docs endpoint (e.g. `curl http://localhost:8080/v3/api-docs > api-docs.json`). Ignore this if you already have a source document.',
		});
		return messages;
	},
};
