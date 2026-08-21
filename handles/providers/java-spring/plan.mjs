import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findMappingAnnotations } from '../../../scanners/adapters/_java-spring-analyzer.mjs';

// The "canonical fetch" for an entity: a GET endpoint whose path is exactly
// `${controller.basePath}/{id}` (one trailing path param, nothing after it) on a controller
// whose CLASS NAME contains the entity's name -- e.g. `GET /organizations/{organizationId}` on
// `OrganizationController` for entity `Organization`, not `OperatorController`'s endpoints
// (`OperatorController` doesn't contain "Organization", so it's never considered even though
// it lives in the same module and its base path also starts with `/organizations/...`).
//
// Bug this fixes (found while testing against the real module, which has BOTH
// OrganizationController and OperatorController): using controllers[0]'s basePath for every
// entity, instead of each candidate controller's own basePath + a name-affinity check, matched
// Organization's fetch operation against OperatorController's basePath and silently found
// nothing (or worse, could have matched the wrong controller's endpoint in a module shaped
// differently).
function findFetchOperation(controllers, entityClassName) {
	const needle = entityClassName.toLowerCase();
	for (const controller of controllers) {
		if (!controller.className.toLowerCase().includes(needle)) continue;
		for (const ep of controller.endpoints) {
			if (ep.verb !== 'GET' || !ep.operationId) continue;
			const suffix = ep.path.slice(controller.basePath.length);
			if (/^\/\{[^/]+\}$/.test(suffix)) {
				return { operationId: ep.operationId, method: ep.method, path: ep.path, controllerFile: controller.file, controllerClassName: controller.className };
			}
		}
	}
	return null;
}

// A2 Phase 1 (D-java-analyzer): this used to duplicate scanners/adapters/java-spring.mjs's own
// (then-brittle) mapping regex, kept separate only because THIS function needs each match's
// source *position* (to locate the region immediately above one specific method), not just the
// endpoint list plan.mjs already has -- the earlier comment here explicitly earmarked "a
// different catalog item's territory" for whoever eventually fixed the regex itself. That's this
// item: findMappingAnnotations() (shared with the scanner) now owns the actual matching, this
// file only maps its richer records down to the {index, methodName} shape findRequiredAuthority()
// below already consumes -- findRequiredAuthority()/extractPreAuthorize()/classBodyStart() are
// completely unchanged, D-security-7's own region-carving logic untouched.
const HAS_ROLE_RE = /@PreAuthorize\(\s*"hasRole\('([^']+)'\)"\s*\)/;
const PRE_AUTH_RE = /@PreAuthorize\(/;

function methodMappingBoundaries(text) {
	return findMappingAnnotations(text).map((m) => ({ index: m.index, methodName: m.methodName }));
}

// Index just after the class body's opening brace -- the lower bound for a method-level search
// when the target is the FIRST method in the file (no prior method boundary to anchor to).
// Without this, that search's region would fall back to 0 and swallow the class-level
// annotations (@PreAuthorize included) that sit BEFORE `class X {`, which is exactly the
// class-vs-method conflation this fix exists to prevent.
function classBodyStart(text) {
	const m = text.match(/\bclass\s+\w+[^{]*\{/);
	return m ? m.index + m[0].length : 0;
}

// Returns { authority, unsupported } for an @PreAuthorize search over one region of source text.
// `unsupported: true` means an @PreAuthorize annotation IS present but isn't the simple
// hasRole('X') shape this regex-based scanner understands (hasAnyRole, SpEL, etc.) -- the caller
// must fail closed (TODO_ROLE) rather than silently treating it as "no authority found" and
// falling back to a weaker/wrong source.
function extractPreAuthorize(region) {
	if (!PRE_AUTH_RE.test(region)) return null;
	const hasRoleMatch = region.match(HAS_ROLE_RE);
	return hasRoleMatch ? { authority: hasRoleMatch[1], unsupported: false } : { authority: null, unsupported: true };
}

// D-security-7: a controller with more than one method can require DIFFERENT roles per method --
// the previous version always used the file's FIRST @PreAuthorize match, which for a controller
// whose first-declared method happens to carry a weaker role than the actual fetch method being
// planned would silently generate a resolver enforcing that weaker role instead. Found by the
// Codex security review. Now searches method-level first: the region from the previous method's
// mapping annotation (exclusive) up to this method's mapping annotation (exclusive) is exactly
// the span that can only contain this method's own annotations, never the previous method's (its
// own @PreAuthorize, if any, sits before that boundary). Only falls back to a genuine class-level
// @PreAuthorize -- the region before the FIRST method mapping in the file -- when the method
// level has nothing at all.
function findRequiredAuthority(controllerFilePath, methodName) {
	if (!controllerFilePath || !methodName || !fs.existsSync(controllerFilePath)) {
		return { authority: null, unsupported: false };
	}
	const text = fs.readFileSync(controllerFilePath, 'utf8');
	const boundaries = methodMappingBoundaries(text);
	const target = boundaries.find((b) => b.methodName === methodName);
	if (!target) return { authority: null, unsupported: false };

	const priorBoundaries = boundaries.filter((b) => b.index < target.index);
	const methodRegionStart = priorBoundaries.length > 0 ? priorBoundaries[priorBoundaries.length - 1].index : classBodyStart(text);
	const methodLevel = extractPreAuthorize(text.slice(methodRegionStart, target.index));
	if (methodLevel) return methodLevel;

	const classRegion = text.slice(0, boundaries[0].index);
	const classLevel = extractPreAuthorize(classRegion);
	return classLevel ?? { authority: null, unsupported: false };
}

// Heuristic (this codebase's convention, verified for Organization -> OrganizationService, not
// guaranteed for every entity): <Entity>Service under domain/<module>/application/. Only
// trusted if the file actually exists -- see D-resolver-scope in DECISIONS.md for why a
// resolver is only generated when this resolves to a real file, not a guessed import.
function findServiceFile(javaSrcRoot, module, entityClassName) {
	const guessedType = `${entityClassName}Service`;
	const guessedPath = path.join(javaSrcRoot, 'domain', module, 'application', `${guessedType}.java`);
	return fs.existsSync(guessedPath) ? { serviceType: guessedType, file: guessedPath } : null;
}

// Counts top-level commas in a captured argument list, treating `<...>` (generics) as non-
// splitting -- good enough for interface method signatures, which is all this reads.
function countTopLevelCommas(argsText) {
	let depth = 0;
	let count = 0;
	for (const ch of argsText) {
		if (ch === '<') depth++;
		else if (ch === '>') depth = Math.max(0, depth - 1);
		else if (ch === ',' && depth === 0) count++;
	}
	return count;
}

// D-security-8: ResourceResolverStub.java.tmpl always generates `fetch(UUID resourceUid)` as
// `{{SERVICE_FIELD}}.{{FETCH_METHOD}}(resourceUid)` -- exactly one argument, by construction. If
// the real service method actually requires more (a common shape for anything scoped under an
// org/cohort, e.g. `find(UUID organizationId, UUID cohortId)`), that's not just a compile error:
// a method with the SAME NAME but a different single-UUID-arg overload could exist and get called
// instead, silently dropping the scoping argument (an IDOR-shaped bug, not just a build failure).
// Found by the Codex security review. Returns null if the method signature can't be found at all
// (fails closed the same as a param-count mismatch -- caller must not assume 1).
function countServiceMethodParams(serviceFilePath, methodName) {
	if (!serviceFilePath || !methodName || !fs.existsSync(serviceFilePath)) return null;
	const text = fs.readFileSync(serviceFilePath, 'utf8');
	const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const sigRe = new RegExp(`\\S+(?:<[^;{}]*?>)?\\s+${escaped}\\s*\\(([^)]*)\\)`);
	const match = text.match(sigRe);
	if (!match) return null;
	const argsText = match[1].trim();
	return argsText === '' ? 0 : countTopLevelCommas(argsText) + 1;
}

export function planHandles({ javaSrcRoot, scanReport, module: moduleName, resourceFilter }) {
	const targetModule = moduleName
		? scanReport.related_modules.find((m) => m.module === moduleName)
		: scanReport.related_modules[0];

	if (!targetModule) {
		return { module: null, resources: [], notes: ['no related module in the scan report -- run `bskel scan` first, or pass --module explicitly'] };
	}

	const resources = [];
	const notes = [];

	for (const entity of targetModule.entities) {
		if (resourceFilter && !resourceFilter.includes(entity.className)) continue;
		const fetchOp = findFetchOperation(targetModule.controllers, entity.className);
		const authorityResult = findRequiredAuthority(fetchOp?.controllerFile ?? null, fetchOp?.method ?? null);
		const requiredAuthority = authorityResult.authority;
		const service = findServiceFile(javaSrcRoot, targetModule.module, entity.className);
		const serviceParamCount = (service && fetchOp) ? countServiceMethodParams(service.file, fetchOp.method) : null;

		if (!fetchOp) {
			notes.push(`${entity.className}: no single-resource GET endpoint found on a controller whose name contains "${entity.className}" -- fetch() will need to be hand-written`);
		} else if (authorityResult.unsupported) {
			notes.push(`${entity.className}: @PreAuthorize found on ${fetchOp.controllerClassName}.${fetchOp.method} (or its class) but not in the simple hasRole('X') shape this scanner understands (e.g. hasAnyRole/SpEL) -- requiredAuthority() defaults to "TODO_ROLE" (fails closed) until a human fixes it`);
		} else if (!requiredAuthority) {
			notes.push(`${entity.className}: no method-level or class-level @PreAuthorize(hasRole(...)) found for ${fetchOp.controllerClassName}.${fetchOp.method} -- requiredAuthority() defaults to "TODO_ROLE", fix before relying on it`);
		}
		if (!service) {
			notes.push(`${entity.className}: no ${entity.className}Service found under domain/${targetModule.module}/application/ -- resolver NOT generated for this entity (would produce a broken import). Emit it by hand once the right service is identified.`);
		} else if (fetchOp && serviceParamCount !== 1) {
			const reason = serviceParamCount === null
				? `could not find a ${fetchOp.method}(...) method on ${service.serviceType} to confirm its argument count`
				: `${service.serviceType}.${fetchOp.method} takes ${serviceParamCount} argument(s), not the single resource UUID the generated resolver always passes`;
			notes.push(`${entity.className}: ${reason} -- resolver NOT generated (would either fail to compile or silently call the wrong overload and drop a required scoping argument, e.g. an organization/cohort id). Wire it by hand.`);
		}

		resources.push({
			type: entity.className,
			table: entity.table,
			idField: entity.idField,
			fetchOperation: fetchOp,
			requiredAuthority: requiredAuthority ?? 'TODO_ROLE',
			service,
			willGenerateResolver: Boolean(fetchOp && service && serviceParamCount === 1),
		});
	}

	if (resources.length === 0) {
		notes.push(`no entities found for module "${targetModule.module}" ${resourceFilter ? `matching --resource filter [${resourceFilter.join(', ')}]` : ''} -- nothing to plan.`);
	}

	return { module: targetModule.module, resources, notes };
}

// Detected from the Spring Boot `*Application.java` file's own package declaration, rather
// than assumed/configured -- works for any Spring Boot project following the standard
// convention, not just Team-IZ-Backend's specific `com.bigproject.backend`. Moved here from the
// pre-G4 handles/emit.mjs -- G1's original `bin/bskel.mjs`-level `detectBasePackageOrExit` no
// longer exists; the CLI has no Java-specific knowledge left, this provider owns it entirely.
//
// O6: previously used files[0] unconditionally when the glob matched more than one
// *Application.java -- silently picking whichever one `rg --files`'s (unordered, see the .sort()
// below) traversal happened to return first. Multiple candidates that all declare the SAME
// package (a common multi-module-monorepo shape) aren't actually ambiguous, so that case still
// resolves quietly; only genuinely DIFFERENT packages throw, naming every candidate so the caller
// can see why. There is no existing repo in this project's real-world testing with more than one
// application root, so this is unverified against a real multi-app case -- see
// D-artifact-determinism's EXIT in DECISIONS.md for why no override flag was added speculatively.
export function detectBasePackage(repoRoot) {
	const srcRoot = path.join(repoRoot, 'src', 'main', 'java');
	if (!fs.existsSync(srcRoot)) return null;
	let files;
	try {
		files = execFileSync('rg', ['--files', '-g', '*Application.java', srcRoot], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
	} catch {
		files = [];
	}
	if (files.length === 0) return null;
	const packages = new Set(
		files.map((f) => fs.readFileSync(f, 'utf8').match(/^package\s+([\w.]+);/m)?.[1]).filter(Boolean),
	);
	if (packages.size > 1) {
		throw new Error(
			`ambiguous base package -- found ${files.length} *Application.java file(s) declaring ${packages.size} different packages: ` +
			`${files.map((f) => path.relative(repoRoot, f)).join(', ')}. This tool doesn't support multi-application-root repos yet.`,
		);
	}
	return packages.size === 1 ? [...packages][0] : null;
}

// The descriptor-facing entry point (handles/providers/java-spring.mjs's provider.plan). Wraps
// planHandles() above with base-package detection and the framework-neutral sbf.handles-plan/1
// envelope -- see schemas/handles-plan.schema.json. `basePackage` rides along as a provider-
// specific extra field (additionalProperties: true) so emit() below can reuse the SAME detected
// value instead of re-detecting it (each is a separate `bskel handles plan`/`bskel handles emit`
// process invocation, but within one process this plan object is computed once and threaded
// through -- a small improvement over the pre-G4 code, which detected it independently in each
// command's own function body; detectBasePackage is deterministic so this changes no observable
// behavior).
export function plan({ repoRoot, scanReport, module: moduleName, resourceFilter }) {
	const basePackage = detectBasePackage(repoRoot);
	if (!basePackage) {
		throw new Error('could not detect the base package (no *Application.java found under src/main/java) -- is this a Spring Boot project?');
	}
	const javaSrcRoot = path.join(repoRoot, 'src', 'main', 'java', ...basePackage.split('.'));
	const inner = planHandles({ javaSrcRoot, scanReport, module: moduleName, resourceFilter });
	return {
		schema: 'sbf.handles-plan/1',
		provider: 'java-spring',
		basePackage,
		module: inner.module,
		resources: inner.resources.map((r) => ({
			...r,
			readPath: (r.service && r.fetchOperation) ? `${r.service.serviceType}.${r.fetchOperation.method}()` : null,
		})),
		notes: inner.notes,
	};
}
