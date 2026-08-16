// Ripgrep-for-discovery + full-file regex-for-structure. Deliberately no real Java parser (see
// DECISIONS.md / the plan's Component 2) -- good enough to find "does a related module already
// exist" without a compiler dependency, not a general-purpose Java analyzer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAPPING_VERBS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

export function detectJavaSpringRoot(repoRoot) {
	const buildFiles = ['build.gradle', 'build.gradle.kts', 'pom.xml'];
	if (!buildFiles.some((f) => fs.existsSync(path.join(repoRoot, f)))) return null;
	const srcRoot = path.join(repoRoot, 'src', 'main', 'java');
	return fs.existsSync(srcRoot) ? srcRoot : null;
}

// O6: `rg --files` (no `--sort`) is explicitly unordered/parallel by ripgrep's own docs -- two
// runs against an unchanged repo can return files in a different order, which without this sort
// would propagate into non-deterministic controller/entity/module array order in every scan
// report and contract, causing spurious diffs even when nothing real changed.
function listJavaFiles(srcRoot) {
	const out = execFileSync('rg', ['--files', '-g', '*.java', srcRoot], { encoding: 'utf8' });
	return out.split('\n').filter(Boolean).sort();
}

function stripComments(text) {
	// Block comments (incl. javadoc) then line comments. Not full lexing -- a "//" inside a
	// string literal would confuse this, but none of the target files put that inside an enum
	// body, which is the only place this is used.
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
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

function extractController(text, filePath) {
	if (!/@RestController\b/.test(text)) return null;
	const classMatch = text.match(/public\s+class\s+(\w+)/);
	const className = classMatch ? classMatch[1] : path.basename(filePath, '.java');

	// Class-level @RequestMapping: match the one shortly before `class <Name>`, not any
	// method-level mapping (this codebase's methods use @GetMapping/@PostMapping/etc., not
	// @RequestMapping, so in practice there is exactly one -- but anchor to `class` anyway).
	const classMappingMatch = text.match(/@RequestMapping\(([\s\S]*?)\)\s*\n[\s\S]{0,200}?class\s+\w+/);
	const basePath = classMappingMatch ? (extractQuotedOrValue(classMappingMatch[1]) ?? '') : '';

	// Document-order list of every operationId in the file -- this is what the acceptance
	// oracle (10 operationIds for Team-IZ-Backend's OrganizationController) checks directly.
	const operationIds = [...text.matchAll(/operationId\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
	const operationStarts = [...text.matchAll(/@Operation\(/g)].map((m) => m.index);

	const mappingRe = new RegExp(
		`@(${MAPPING_VERBS.join('|')})Mapping(?:\\(([\\s\\S]*?)\\))?\\s*\\n\\s*public\\s+\\S+\\s+(\\w+)\\s*\\(`,
		'g',
	);
	const endpoints = [];
	for (const m of text.matchAll(mappingRe)) {
		const verb = m[1].toUpperCase();
		const segment = extractQuotedOrValue(m[2] ?? null) ?? '';
		const methodName = m[3];

		// Correlate with the nearest PRECEDING @Operation( block, even when an @ApiResponses
		// (or similar) annotation sits between it and this mapping -- heuristic, not a parser.
		let operationId = null;
		const preceding = operationStarts.filter((idx) => idx < m.index);
		if (preceding.length > 0) {
			const between = text.slice(preceding[preceding.length - 1], m.index);
			const idMatch = between.match(/operationId\s*=\s*"([^"]+)"/);
			if (idMatch) operationId = idMatch[1];
		}
		endpoints.push({ verb, path: joinPath(basePath, segment), operationId, method: methodName });
	}

	return { className, basePath, operationIds, endpoints, file: filePath };
}

function extractEntity(text, filePath) {
	if (!/@Entity\b/.test(text)) return null;
	const classMatch = text.match(/public\s+class\s+(\w+)/);
	const tableMatch = text.match(/@Table\(\s*name\s*=\s*"([^"]+)"/);
	const idFieldMatch = text.match(/@Id\b[\s\S]{0,200}?private\s+\S+\s+(\w+)\s*;/);
	return {
		className: classMatch ? classMatch[1] : path.basename(filePath, '.java'),
		table: tableMatch ? tableMatch[1] : null,
		idField: idFieldMatch ? idFieldMatch[1] : null,
		file: filePath,
	};
}

function extractDomainEnum(text, filePath) {
	const match = text.match(/public\s+enum\s+(\w+)\s*\{([\s\S]*?)\n\}/);
	if (!match) return null;
	const [, name, rawBody] = match;
	const body = stripComments(rawBody);
	// Each constant ends at the first `,` `;` (or the start of a constructor-arg `(` if present).
	const constants = body
		.split(/[,;]/)
		.map((s) => s.trim().split('(')[0].trim())
		.filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s));
	return { name, constants, file: filePath };
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
	const srcRoot = path.join(repoRoot, 'src', 'main', 'java');
	if (fs.existsSync(srcRoot)) {
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
			moduleEntry(mod).dtos.push(path.basename(file, '.java'));
		}
	}

	return { srcRoot, modules: [...modules.values()], pathPrefixSignals: detectGlobalPathPrefixSignals(repoRoot) };
}
