import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findMappingAnnotations, findMethodParams, maskNonCode, matchBalanced } from '../../../scanners/adapters/_java-spring-analyzer.mjs';
import { lineNumberAt } from '../../../scanners/text-util.mjs';
import { classifyDtoFields, splitTopLevelParams, extractTypeAndName } from './patch-strategy.mjs';

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
				// X5 (D-route-expansion-provenance): threaded through so the caller can name the real
				// cause when ep.method is null instead of a bare "method not found" message -- a 1:N
				// framework-synthesized route (e.g. Spring Data REST) has a real operationId but no
				// literal per-action method to correlate to. null on every endpoint in today's adapter
				// (it never populates declarationIndex) -- forward-compatible only, not yet reachable.
				const declaration = ep.declarationIndex != null ? (controller.declarations?.[ep.declarationIndex] ?? null) : null;
				return { operationId: ep.operationId, method: ep.method, path: ep.path, controllerFile: controller.file, controllerClassName: controller.className, declaration };
			}
		}
	}
	return null;
}

// A3 (D-patch-strategy): the update-endpoint counterpart to findFetchOperation() above -- same
// name-affinity-gated controller search (a controller must contain the entity's name), same
// single-path-param shape (`${controller.basePath}/{id}`, nothing after it) confirmed against
// every real update endpoint in the oracle repo's grounding (all `@PatchMapping`, PUT accepted
// too since nothing in this codebase's own conventions rules it out). Deliberately does not
// require an operationId -- unlike fetch(), patch codegen never needs one, only the controller
// file + Java method name to locate the @RequestBody DTO parameter.
function findUpdateOperation(controllers, entityClassName) {
	const needle = entityClassName.toLowerCase();
	for (const controller of controllers) {
		if (!controller.className.toLowerCase().includes(needle)) continue;
		for (const ep of controller.endpoints) {
			if (ep.verb !== 'PATCH' && ep.verb !== 'PUT') continue;
			const suffix = ep.path.slice(controller.basePath.length);
			if (/^\/\{[^/]+\}$/.test(suffix)) {
				return { method: ep.method, path: ep.path, controllerFile: controller.file, controllerClassName: controller.className };
			}
		}
	}
	return null;
}

// From a controller method's own parameter-list text, finds the @RequestBody-annotated
// parameter's declared type name (e.g. "UpdateOrganizationRequest") -- reuses the same
// annotation-skipping/top-level-split primitives patch-strategy.mjs already exports for
// classifying a DTO's own fields, so a request-body param with several annotations in any order
// (`@Valid @RequestBody X x` or `@RequestBody @Valid X x`) is found the same way either way.
// Returns null if no @RequestBody parameter is found (a GET-shaped or bodyless update method,
// which for PATCH/PUT would be unusual but is not assumed impossible).
function findRequestBodyTypeName(controllerFilePath, methodName) {
	const params = findMethodParams(fs.readFileSync(controllerFilePath, 'utf8'), methodName);
	if (params === null) return null;
	const maskedParams = maskNonCode(params);
	const segment = splitTopLevelParams(maskedParams).find((s) => /@RequestBody\b/.test(s));
	if (!segment) return null;
	const parsed = extractTypeAndName(segment);
	return parsed ? parsed.baseType : null;
}

// Resolves the update DTO's own .java file the same way findServiceFile() resolves a service --
// only trusted if the file actually exists at the convention this codebase's real DTOs all use
// (domain/<module>/presentation/dto/<TypeName>.java, confirmed against all 17 real update DTOs
// during this item's grounding). A DTO living somewhere else is a documented gap: patchable stays
// empty for that resource, exactly like findServiceFile()'s own "resolver NOT generated" fallback
// for a service that can't be found.
// D-write-safety-phase1 (item 4b): a real, bounded fallback -- after the domain/<module>/
// presentation/dto/ convention (Team-IZ-Backend's own shape) fails, also try the DTO directly
// under <module>/ with no domain/presentation/dto middle segments, the natural flat-package
// variant of the same convention (javaSrcRoot is already base-package-anchored -- see
// detectBasePackage() -- so this is `<basePackage>/<module>/<Type>.java`, not a second guessed
// base). Does not attempt any other shape: no second real oracle has ever validated one, and
// guessing further risks W9-style overfitting to an imagined repo rather than a confirmed one.
function findUpdateDtoFile(javaSrcRoot, module, dtoTypeName) {
	const conventional = path.join(javaSrcRoot, 'domain', module, 'presentation', 'dto', `${dtoTypeName}.java`);
	if (fs.existsSync(conventional)) return conventional;
	const flat = path.join(javaSrcRoot, module, `${dtoTypeName}.java`);
	return fs.existsSync(flat) ? flat : null;
}

// The full patchable-field pipeline for one entity: find its update endpoint -> find the
// @RequestBody DTO type -> find that DTO's file -> classify its fields. Returns `{ patchable:
// [...], updateOperation, updateDtoFile, notes: [...] }` -- notes explain exactly which step
// failed when patchable ends up empty, mirroring willGenerateResolver's own note-per-reason
// convention rather than a silent empty array.
function planPatchable({ javaSrcRoot, module: moduleName, controllers, entityClassName }) {
	const notes = [];
	const updateOperation = findUpdateOperation(controllers, entityClassName);
	if (!updateOperation) {
		return { patchable: [], updateOperation: null, updateDtoFile: null, notes: [`${entityClassName}: no PATCH/PUT single-resource endpoint found -- patchField() stays a blanket stub`] };
	}
	const dtoTypeName = findRequestBodyTypeName(updateOperation.controllerFile, updateOperation.method);
	if (!dtoTypeName) {
		notes.push(`${entityClassName}: found ${updateOperation.controllerClassName}.${updateOperation.method} but couldn't determine its @RequestBody DTO type -- patchField() stays a blanket stub`);
		return { patchable: [], updateOperation, updateDtoFile: null, notes };
	}
	const updateDtoFile = findUpdateDtoFile(javaSrcRoot, moduleName, dtoTypeName);
	if (!updateDtoFile) {
		notes.push(`${entityClassName}: request body type "${dtoTypeName}" not found under domain/${moduleName}/presentation/dto/ -- patchField() stays a blanket stub`);
		return { patchable: [], updateOperation, updateDtoFile: null, notes };
	}
	const classified = classifyDtoFields(fs.readFileSync(updateDtoFile, 'utf8'));
	if (!classified) {
		notes.push(`${entityClassName}: ${dtoTypeName} is not a record (or has no canonical constructor) -- patchField() stays a blanket stub`);
		return { patchable: [], updateOperation, updateDtoFile, notes };
	}
	return { patchable: classified.fields, updateOperation, updateDtoFile, dtoTypeName, notes };
}

// D-resolver-policy-contract (PC1/PC2/PC3): replaces the old extractPreAuthorize()/
// findRequiredAuthority()/methodMappingBoundaries() with an explicit refusal ladder producing a
// full policy RECORD (not just a scalar authority string) -- see DECISIONS.md's
// D-resolver-policy-contract for the WHY: a @PreAuthorize("hasRole('USER')") sitting next to a
// @PostAuthorize("returnObject.ownerId == authentication.name") ownership check used to
// auto-materialize ROLE_USER and silently ignore the ownership check entirely -- a real IDOR bskel
// itself would introduce. The provably-safe set (hasRole('X') / hasAuthority('X') alone, nothing
// else in the region) is UNCHANGED from before (O5) -- this item only adds refusal rungs in FRONT
// of it, so every case that materialized correctly before still does (frozen, not widened).
//
// O5 (D-resolver-authorization-action-aware, hasAuthority follow-up): hasRole('X') and
// hasAuthority('X') are NOT interchangeable at the Spring Security level -- hasRole('X') checks
// for the granted authority "ROLE_X" (an implicit prefix Spring itself applies), hasAuthority('X')
// checks for "X" verbatim. The returned `authority` string is the LITERAL granted-authority value
// the generated code must match, decided HERE (plan time), not left for the template to re-derive.
const HAS_ROLE_RE = /@PreAuthorize\(\s*"hasRole\('([^']+)'\)"\s*\)/;
const HAS_AUTHORITY_RE = /@PreAuthorize\(\s*"hasAuthority\('([^']+)'\)"\s*\)/;

// D-resolver-policy-contract (PC3): companion annotations that can carry authorization logic
// @PreAuthorize's own simple-shape check can never see (ownership/SpEL/etc.) -- their mere
// PRESENCE in a method's or class's authorization region refuses auto-materialization outright,
// regardless of whether a perfectly-shaped @PreAuthorize ALSO sits in the same region. Verified
// live: none of these five appear anywhere in this repository today (grep, zero hits) -- so this
// rung changes nothing for any case this codebase currently exercises; it exists for target repos
// that DO use them.
const COMPANION_AUTHZ_RE = /@(PostAuthorize|Secured|RolesAllowed|PreFilter|PostFilter)\s*\(/g;
const PRE_AUTHORIZE_SCAN_RE = /@PreAuthorize\s*\(/g;
const EVIDENCE_TEXT_MAX = 200;

// D-resolver-policy-contract (PC2): the 8 evidence.kind values the ladder below can produce, in
// the exact order DECISIONS.md documents them. Exported so schemas/handles-plan.schema.json's own
// enum and test/handles-policy-contract.test.mjs can be asserted to never drift apart silently.
export const POLICY_EVIDENCE_KINDS = Object.freeze([
	'endpoint-absent',
	'endpoint-method-absent',
	'companion-annotation-present',
	'pre-authorize-ambiguous',
	'pre-authorize-unrecognized',
	'authorization-annotation-absent',
	'pre-authorize-has-role',
	'pre-authorize-has-authority',
]);

// D-resolver-policy-contract (PC2 follow-up, found live): an unresolved record whose
// evidence.kind is 'endpoint-absent'/'endpoint-method-absent' means the underlying route
// STRUCTURALLY DOES NOT EXIST for this action -- e.g. a read-only resource with no PATCH/PUT
// endpoint at all. That is the SAME "nothing to protect" case this codebase has silently accepted
// via TODO_ROLE forever (planHandles()'s own `requiredAuthorityForPatch ?? 'TODO_ROLE'`, unnoted
// when no update endpoint exists) -- NOT the gap this item exists to close (an endpoint that DOES
// exist but couldn't be safely verified). Found live: without this exclusion, willGenerateResolver
// (which never depends on the UPDATE endpoint existing at all -- a read-only resource is a normal,
// common shape) would delegate/block emit for every read-only resource, a real regression this
// project's own real fixtures caught immediately. Exported so emit.mjs's unresolvedPolicies gate
// uses the exact same rule -- one place decides "does this unresolved record need a human."
export function policyRequiresResolution(p) {
	return p.status === 'unresolved' && p.evidence.kind !== 'endpoint-absent' && p.evidence.kind !== 'endpoint-method-absent';
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

function normalizeEvidenceText(s) {
	const collapsed = s.replace(/\s+/g, ' ').trim();
	return collapsed.length > EVIDENCE_TEXT_MAX ? `${collapsed.slice(0, EVIDENCE_TEXT_MAX)}…` : collapsed;
}

// Finds every match of a global annotation-start regex (`re`, must end in a literal `\(` so its
// own match always ends exactly on the opening paren) whose `@` sits within [start, end) of
// `masked`, resolving each one's balanced `(...)` via matchBalanced() and slicing the ORIGINAL
// (unmasked) `text` for `.text` -- values are never read off masked/blanked content, matching
// this analyzer's own established convention.
function collectAnnotations(masked, text, re, start, end) {
	const found = [];
	re.lastIndex = start;
	let m;
	while ((m = re.exec(masked))) {
		if (m.index >= end) break;
		const openParen = m.index + m[0].length - 1;
		const close = matchBalanced(masked, openParen, '(', ')');
		if (close === -1) continue; // malformed -- skip, don't misattribute
		found.push({ index: m.index, text: normalizeEvidenceText(text.slice(m.index, close + 1)) });
	}
	return found;
}

function evidenceRecord({ kind, scope, file, line, symbol, text }) {
	return { kind, scope: scope ?? null, file: file ?? null, line: line ?? null, symbol: symbol ?? null, text: text ?? null };
}

function policyRecord({ action, mode, status, authority, evidence, reason }) {
	return { action, mode, status, authority: authority ?? null, evidence, reason: reason ?? null };
}

// Runs the companion-annotation / @PreAuthorize-count / exact-shape rungs (D3's rungs 2-4) over
// one region ([start, end) of `masked`/`text`). Returns null (not a refusal, just "nothing here")
// when the region has neither a companion annotation nor any @PreAuthorize at all -- the caller
// tries the next scope (method -> class) before finally refusing with
// 'authorization-annotation-absent'.
function derivePolicyFromRegion({ masked, text, start, end, scope, action, controllerFile, controllerFileRel, symbol }) {
	const companions = collectAnnotations(masked, text, COMPANION_AUTHZ_RE, start, end);
	if (companions.length > 0) {
		const line = lineNumberAt(text, companions[0].index);
		const names = companions.map((c) => c.text).join(', ');
		return policyRecord({
			action, mode: 'delegated', status: 'unresolved',
			evidence: evidenceRecord({ kind: 'companion-annotation-present', scope, file: controllerFileRel, line, symbol, text: companions.map((c) => c.text).join(' | ') }),
			reason: `${controllerFileRel}:${line}: ${symbol} carries ${names} -- this scanner cannot safely verify what a companion authorization annotation enforces (ownership/tenant checks are common here), so authorization is NOT auto-materialized even though a @PreAuthorize may also be present. Implement the generated AuthorizationPolicy interface by hand, using the annotation text above as the specification.`,
		});
	}
	const preAuths = collectAnnotations(masked, text, PRE_AUTHORIZE_SCAN_RE, start, end);
	if (preAuths.length > 1) {
		const line = lineNumberAt(text, preAuths[0].index);
		return policyRecord({
			action, mode: 'delegated', status: 'unresolved',
			evidence: evidenceRecord({ kind: 'pre-authorize-ambiguous', scope, file: controllerFileRel, line, symbol, text: preAuths.map((p) => p.text).join(' | ') }),
			reason: `${controllerFileRel}:${line}: ${symbol} carries ${preAuths.length} @PreAuthorize annotations in the same ${scope}-level region -- ambiguous which one governs ${action}. Write authorize() by hand.`,
		});
	}
	if (preAuths.length === 1) {
		const p = preAuths[0];
		const line = lineNumberAt(text, p.index);
		const hasRoleMatch = p.text.match(HAS_ROLE_RE);
		if (hasRoleMatch) {
			return policyRecord({
				action, mode: 'role', status: 'materialized', authority: `ROLE_${hasRoleMatch[1]}`,
				evidence: evidenceRecord({ kind: 'pre-authorize-has-role', scope, file: controllerFileRel, line, symbol, text: p.text }),
			});
		}
		const hasAuthorityMatch = p.text.match(HAS_AUTHORITY_RE);
		if (hasAuthorityMatch) {
			return policyRecord({
				action, mode: 'role', status: 'materialized', authority: hasAuthorityMatch[1],
				evidence: evidenceRecord({ kind: 'pre-authorize-has-authority', scope, file: controllerFileRel, line, symbol, text: p.text }),
			});
		}
		return policyRecord({
			action, mode: 'delegated', status: 'unresolved',
			evidence: evidenceRecord({ kind: 'pre-authorize-unrecognized', scope, file: controllerFileRel, line, symbol, text: p.text }),
			reason: `${controllerFileRel}:${line}: ${symbol}'s @PreAuthorize (${p.text}) is not exactly hasRole('X') or hasAuthority('X') -- this scanner does not evaluate SpEL (hasAnyRole/hasAnyAuthority/compound expressions included). Write authorize() by hand.`,
		});
	}
	return null;
}

// D-resolver-policy-contract (PC3): the refusal ladder's entry point. `operation` is whatever
// findFetchOperation()/findUpdateOperation() returned (or null). Modeled directly on
// scanners/adapters/java-spring.mjs's extractRepositoryResource() -- an ordered sequence of
// checks, each non-matching rung returning an explicit, reasoned refusal rather than a best-effort
// guess. The companion-annotation rung runs BEFORE any @PreAuthorize matching, on purpose: this is
// the rung that closes the @PostAuthorize-ownership-check gap named in DECISIONS.md's WHY.
function derivePolicy({ action, operation, repoRoot }) {
	const rel = (p) => (repoRoot && p ? path.relative(repoRoot, p) : p);

	if (!operation) {
		return policyRecord({
			action, mode: 'delegated', status: 'unresolved',
			evidence: evidenceRecord({ kind: 'endpoint-absent' }),
			reason: `no ${action === 'fetch' ? 'single-resource GET' : 'single-resource PATCH/PUT'} endpoint found for this action -- write authorize() by hand once one exists`,
		});
	}
	if (!operation.method || !operation.controllerFile) {
		const declNote = operation.declaration
			? ` -- it was expanded from ${operation.declaration.label ?? operation.declaration.rule}, a framework-synthesized route with no literal per-action source method to correlate to`
			: ' -- no literal per-action source method exists to correlate to';
		return policyRecord({
			action, mode: 'delegated', status: 'unresolved',
			evidence: evidenceRecord({ kind: 'endpoint-method-absent', file: rel(operation.controllerFile) }),
			reason: `matched endpoint (${action} ${operation.path ?? ''})${declNote}. Write authorize() by hand.`,
		});
	}

	const controllerFile = operation.controllerFile;
	const controllerFileRel = rel(controllerFile);
	const symbol = `${operation.controllerClassName}.${operation.method}`;
	const text = fs.readFileSync(controllerFile, 'utf8');
	const masked = maskNonCode(text);
	const mappings = findMappingAnnotations(text);
	const target = mappings.find((m) => m.methodName === operation.method);
	if (!target) {
		return policyRecord({
			action, mode: 'delegated', status: 'unresolved',
			evidence: evidenceRecord({ kind: 'endpoint-method-absent', file: controllerFileRel, symbol }),
			reason: `${controllerFileRel}: could not re-locate ${symbol} via its own mapping annotation -- write authorize() by hand.`,
		});
	}
	const priorSameFile = mappings.filter((m) => m.index < target.index);
	const methodStart = priorSameFile.length > 0 ? priorSameFile[priorSameFile.length - 1].signatureIndex : classBodyStart(text);
	const methodEnd = target.signatureIndex;
	const classRegionEnd = mappings[0].index;

	const methodResult = derivePolicyFromRegion({ masked, text, start: methodStart, end: methodEnd, scope: 'method', action, controllerFile, controllerFileRel, symbol });
	if (methodResult) return methodResult;

	const classResult = derivePolicyFromRegion({ masked, text, start: 0, end: classRegionEnd, scope: 'class', action, controllerFile, controllerFileRel, symbol });
	if (classResult) return classResult;

	return policyRecord({
		action, mode: 'delegated', status: 'unresolved',
		evidence: evidenceRecord({ kind: 'authorization-annotation-absent', file: controllerFileRel, symbol }),
		reason: `no @PreAuthorize (method- or class-level) found for ${symbol} -- authorization may be enforced elsewhere (service layer, a SecurityFilterChain) that this scanner cannot see. Write authorize() by hand.`,
	});
}

// Heuristic (this codebase's convention, verified for Organization -> OrganizationService, not
// guaranteed for every entity): <Entity>Service under domain/<module>/application/. Only
// trusted if the file actually exists -- see D-resolver-scope in DECISIONS.md for why a
// resolver is only generated when this resolves to a real file, not a guessed import.
// D-write-safety-phase1 (item 4b): falls back to <module>/<Entity>Service.java directly under
// javaSrcRoot (no domain/application segments) when the conventional path doesn't exist -- the
// flat-package variant of the same convention. Confirmed this does NOT close the real-world case
// that motivated it (spring-projects/spring-petclinic): petclinic has no *Service.java at all
// (controllers call a Spring Data repository directly), and its entities are Integer-keyed, not
// UUID (see idFieldIsUuid's own gate in planHandles() below, which fires first regardless). This
// is a real, independent improvement for a different, plausible shape -- a UUID-keyed entity with
// a Service layer, just not nested under domain/ -- not a claim that it closes the petclinic gap.
function findServiceFile(javaSrcRoot, module, entityClassName) {
	const guessedType = `${entityClassName}Service`;
	const conventional = path.join(javaSrcRoot, 'domain', module, 'application', `${guessedType}.java`);
	if (fs.existsSync(conventional)) return { serviceType: guessedType, file: conventional };
	const flat = path.join(javaSrcRoot, module, `${guessedType}.java`);
	return fs.existsSync(flat) ? { serviceType: guessedType, file: flat } : null;
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

// D-resolver-policy-contract (PC2): `repoRoot` defaults to `javaSrcRoot` so existing direct
// callers (test/handles-plan.test.mjs among them) keep working unmodified -- derivePolicy()'s
// evidence.file is only genuinely repo-relative when the real repoRoot is threaded through by
// plan() below; a caller that omits it still gets a (less pretty, still correct) path.
export function planHandles({ javaSrcRoot, scanReport, module: moduleName, resourceFilter, repoRoot = javaSrcRoot }) {
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

		// D-write-safety-phase1 (item 4a): a non-UUID primary key disqualifies resolver generation
		// entirely, independent of whether a Service class can be found -- fetch(UUID resourceUid)
		// and the sbf1_ handle token format both hard-assume a UUID identity. Checked BEFORE the
		// service lookup so the note names the real, decisive reason instead of the generic "no
		// XService found" note below, which would be true but misleading here (implies the fix is
		// finding/writing a service, when no service could ever make this entity addressable).
		// `=== false` (not just falsy) deliberately excludes `null` (idField itself was never
		// found, e.g. inherited from an unindexed superclass) -- that stays the existing, separate
		// "no XService found" path unchanged, since this scanner genuinely doesn't know the type
		// there, not that it's confirmed non-UUID.
		const pkIsNonUuid = entity.idFieldIsUuid === false;
		if (pkIsNonUuid) {
			notes.push(`${entity.className}: primary key is declared \`${entity.idFieldType}\`, not UUID -- the handles subsystem only generates UUID-addressable resolvers (fetch(UUID resourceUid); the sbf1_ handle token format encodes a UUID). Resolver NOT generated for this entity, and cannot be regardless of where its service file lives. See D-handle-uid-type-binding in DECISIONS.md.`);
		}

		const fetchOp = findFetchOperation(targetModule.controllers, entity.className);
		// X5 (D-route-expansion-provenance): a real, already-fail-closed case, checked explicitly
		// instead of relying on findRequiredAuthority()/countServiceMethodParams()'s own `!methodName`
		// guards to silently swallow it -- those guards return safely (no crash) either way, but
		// without this check the notes below would read literally "...found for X.null" / "could not
		// find a null(...) method", which is confusing, not honest. See D-resolver-scope.
		const fetchOpMissingMethod = Boolean(fetchOp && !fetchOp.method);
		const fetchPolicy = derivePolicy({ action: 'fetch', operation: fetchOp, repoRoot });
		const requiredAuthority = fetchPolicy.authority;
		const service = pkIsNonUuid ? null : findServiceFile(javaSrcRoot, targetModule.module, entity.className);
		const serviceParamCount = (service && fetchOp) ? countServiceMethodParams(service.file, fetchOp.method) : null;

		// O5 (D-resolver-authorization-action-aware): the SAME extraction, run again against the
		// UPDATE (PATCH/PUT) endpoint instead of the fetch (GET) one -- previously nothing ever
		// looked at the update endpoint's own @PreAuthorize at all, so patch() silently reused
		// whichever role fetch() happened to require. Computed independently of planPatchable()'s
		// own (conditional, gated on serviceParamCount===1) call to findUpdateOperation() below --
		// requiredAuthorityForPatch is meaningful even when resolver codegen itself ends up
		// blocked, exactly like requiredAuthority already is unconditional above.
		const updateOpForAuthority = findUpdateOperation(targetModule.controllers, entity.className);
		const patchPolicy = derivePolicy({ action: 'patch', operation: updateOpForAuthority, repoRoot });
		const requiredAuthorityForPatch = patchPolicy.authority;

		if (!fetchOp) {
			notes.push(`${entity.className}: no single-resource GET endpoint found on a controller whose name contains "${entity.className}" -- fetch() will need to be hand-written`);
		} else if (fetchOpMissingMethod) {
			const declaration = fetchOp.declaration;
			const declNote = declaration
				? ` -- it was expanded from ${declaration.label ?? declaration.rule} at ${path.relative(javaSrcRoot, fetchOp.controllerFile)}:${declaration.line} (rule: ${declaration.rule}); the framework generates this handler at runtime, so no literal per-action source method exists to correlate to`
				: ' -- no literal per-action source method exists to correlate to';
			notes.push(`${entity.className}: the matched endpoint (GET ${fetchOp.path})${declNote}. Resolver NOT generated -- this is a structural boundary of static-scan-based handles codegen, not a bug. See D-resolver-scope.`);
		} else if (fetchPolicy.reason) {
			// D-resolver-policy-contract (PC2): the ladder's own reason IS the note now -- see
			// derivePolicy()'s per-rung wording (companion-annotation-present, pre-authorize-
			// ambiguous/unrecognized, authorization-annotation-absent all produce their own precise
			// explanation, replacing the old two-case unsupported/absent note here).
			notes.push(fetchPolicy.reason);
		}
		if (updateOpForAuthority && patchPolicy.reason) {
			notes.push(patchPolicy.reason);
		}
		if (!service) {
			// pkIsNonUuid already explained the real reason above -- this note would be true but
			// redundant (and misleading: it implies finding a service would fix it).
			if (!pkIsNonUuid) {
				notes.push(`${entity.className}: no ${entity.className}Service found under domain/${targetModule.module}/application/ or ${targetModule.module}/ -- resolver NOT generated for this entity (would produce a broken import). Emit it by hand once the right service is identified.`);
			}
		} else if (fetchOp && !fetchOpMissingMethod && serviceParamCount !== 1) {
			const reason = serviceParamCount === null
				? `could not find a ${fetchOp.method}(...) method on ${service.serviceType} to confirm its argument count`
				: `${service.serviceType}.${fetchOp.method} takes ${serviceParamCount} argument(s), not the single resource UUID the generated resolver always passes`;
			notes.push(`${entity.className}: ${reason} -- resolver NOT generated (would either fail to compile or silently call the wrong overload and drop a required scoping argument, e.g. an organization/cohort id). Wire it by hand -- ResourceResolver#fetch/#patchField receive the request's Authentication (D-resolver-authentication-context) for exactly this case, e.g. deriving a tenant/org id the same way the resource's own controller already does.`);
		}
		// X5: fetchOpMissingMethod already pushed its own single, clear note above -- suppressing
		// this one avoids a second, confusing "could not find a null(...) method" note for the same
		// root cause.

		// A3 (D-patch-strategy): only worth computing once fetch()/the resolver itself is actually
		// going to be generated -- an entity with no resolver has nowhere for patchField() codegen
		// to land anyway. Reuses countServiceMethodParams() (D-security-8) against the UPDATE
		// method, expecting exactly 2 args (resource id + the DTO) -- the same IDOR-shaped-bug
		// concern fetch()'s own param-count check exists for: a real update method scoped under an
		// org/cohort (e.g. `update(UUID orgId, UUID cohortId, UpdateXRequest req)`) must never be
		// silently called with the wrong overload or a missing scoping argument.
		let patchResult = { patchable: [], updateOperation: null, updateDtoFile: null, updateServiceBlockedReason: null, notes: [] };
		if (fetchOp && service && serviceParamCount === 1) {
			patchResult = { ...planPatchable({ javaSrcRoot, module: targetModule.module, controllers: targetModule.controllers, entityClassName: entity.className }), updateServiceBlockedReason: null };
			if (patchResult.updateOperation) {
				const updateServiceParamCount = countServiceMethodParams(service.file, patchResult.updateOperation.method);
				if (updateServiceParamCount !== 2) {
					// Classification itself (patchable) stays intact and is still surfaced -- only
					// CODEGEN is blocked. A field's bucket is a fact about the DTO, independent of
					// whether the update service method happens to be safely callable with the (id,
					// dto) shape generated code always assumes; losing that classification here would
					// silently give up on this item's own "precise per-field reason" value the moment
					// a real service signature doesn't match (found live: none of the 3 real update
					// service methods checked during this item's grounding -- Organization/Classroom/
					// Cohort -- actually have the plain 2-arg shape, every one carries an extra
					// scoping/auditing argument -- so this is the COMMON case, not an edge case).
					const reason = updateServiceParamCount === null
						? `could not find a ${patchResult.updateOperation.method}(...) method on ${service.serviceType} to confirm its argument count`
						: `${service.serviceType}.${patchResult.updateOperation.method} takes ${updateServiceParamCount} argument(s), not the (resource id, request DTO) pair generated patch code always passes`;
					patchResult = { ...patchResult, updateServiceBlockedReason: reason, notes: [...patchResult.notes, `${entity.className}: ${reason} -- patchField() fields are classified but none are auto-generated`] };
				}
			}
			notes.push(...patchResult.notes);
		}

		resources.push({
			type: entity.className,
			table: entity.table,
			idField: entity.idField,
			// D-write-safety-phase1 (item 4a): surfaced in --json output too, not just the note --
			// null/null when the type genuinely couldn't be determined (not the same as confirmed
			// non-UUID; see pkIsNonUuid's own `=== false` check above).
			idFieldType: entity.idFieldType,
			idFieldIsUuid: entity.idFieldIsUuid,
			fetchOperation: fetchOp,
			updateOperation: patchResult.updateOperation,
			patchable: patchResult.patchable,
			dtoTypeName: patchResult.dtoTypeName ?? null,
			// A2 Phase 2 (D-java-ast-helper): the one piece of data `bskel handles plan --ast`
			// needs that wasn't previously surfaced past this function's own internal patchResult.
			updateDtoFile: patchResult.updateDtoFile ?? null,
			updateServiceBlockedReason: patchResult.updateServiceBlockedReason,
			requiredAuthority: requiredAuthority ?? 'TODO_ROLE',
			// O5 (D-resolver-authorization-action-aware): independently derived from the UPDATE
			// endpoint's own @PreAuthorize, not copied from requiredAuthority above -- see the
			// computation and its own notes earlier in this loop.
			requiredAuthorityForPatch: requiredAuthorityForPatch ?? 'TODO_ROLE',
			// D-resolver-policy-contract (PC2): the source of truth -- requiredAuthority/
			// requiredAuthorityForPatch above are its legacy scalar PROJECTION, kept for every
			// existing consumer (test files, templates) to keep working unmodified. Exactly two
			// records, action 'fetch' then 'patch' -- 'recover' has no record of its own (it is
			// governed by the 'fetch' record; HandleController#recover uses requiredAuthority()).
			policies: [fetchPolicy, patchPolicy],
			// D-resolver-policy-contract (PC2): one resource = one resolver bean = one mode --
			// if EITHER action is unresolved, the whole resolver is delegated (fail-closed by
			// construction: a resource can't be "half-delegated").
			authorizationMode: (policyRequiresResolution(fetchPolicy) || policyRequiresResolution(patchPolicy)) ? 'delegated' : 'role',
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
	const inner = planHandles({ javaSrcRoot, scanReport, module: moduleName, resourceFilter, repoRoot });
	return {
		schema: 'sbf.handles-plan/1',
		provider: 'java-spring',
		basePackage,
		module: inner.module,
		resources: inner.resources.map((r) => ({
			...r,
			readPath: (r.service && r.fetchOperation && r.fetchOperation.method) ? `${r.service.serviceType}.${r.fetchOperation.method}()` : null,
		})),
		notes: inner.notes,
	};
}
