const FACT_CAPABILITIES = new Set([
	'syntax.top-level-types',
	'syntax.imports',
	'syntax.annotations',
	'method.direct',
	'annotation.resolve',
	'annotation.meta-graph',
	'member.direct',
	'jpa.direct',
]);

function freezeProfile(profile) {
	return Object.freeze({
		...profile,
		requiredFacts: Object.freeze([...profile.requiredFacts]),
		entryAnnotations: Object.freeze([...profile.entryAnnotations]),
		routeAnnotations: Object.freeze({ ...profile.routeAnnotations }),
		knownBlockers: Object.freeze([...profile.knownBlockers]),
	});
}

export const JVM_FRAMEWORK_PROFILES = Object.freeze({
	'spring-web-java': freezeProfile({
		id: 'spring-web-java',
		language: 'java',
		status: 'shadow-ready',
		requiredFacts: [
			'syntax.top-level-types', 'syntax.imports', 'syntax.annotations',
			'method.direct', 'annotation.resolve', 'annotation.meta-graph',
		],
		entryAnnotations: [
			'org.springframework.web.bind.annotation.RestController',
			'org.springframework.stereotype.Controller',
		],
		routeAnnotations: {
			'org.springframework.web.bind.annotation.GetMapping': 'GET',
			'org.springframework.web.bind.annotation.PostMapping': 'POST',
			'org.springframework.web.bind.annotation.PutMapping': 'PUT',
			'org.springframework.web.bind.annotation.PatchMapping': 'PATCH',
			'org.springframework.web.bind.annotation.DeleteMapping': 'DELETE',
			'org.springframework.web.bind.annotation.RequestMapping': 'conditional',
		},
		knownBlockers: [
			'compiler-generated controllers/methods are not source facts',
			'condition/profile-specific bean activation needs approved runtime evidence',
		],
	}),
	'quarkus-jaxrs-java': freezeProfile({
		id: 'quarkus-jaxrs-java',
		language: 'java',
		status: 'profile-only',
		requiredFacts: [
			'syntax.top-level-types', 'syntax.imports', 'syntax.annotations',
			'method.direct', 'annotation.resolve',
		],
		entryAnnotations: [
			'jakarta.ws.rs.Path',
			'javax.ws.rs.Path',
		],
		routeAnnotations: {
			'jakarta.ws.rs.GET': 'GET',
			'jakarta.ws.rs.POST': 'POST',
			'jakarta.ws.rs.PUT': 'PUT',
			'jakarta.ws.rs.PATCH': 'PATCH',
			'jakarta.ws.rs.DELETE': 'DELETE',
			'javax.ws.rs.GET': 'GET',
			'javax.ws.rs.POST': 'POST',
			'javax.ws.rs.PUT': 'PUT',
			'javax.ws.rs.DELETE': 'DELETE',
		},
		knownBlockers: [
			'Quarkus build-time augmentation is not executed by the static language layer',
			'generated endpoints and runtime config need a separately approved exporter/runtime profile',
		],
	}),
	'micronaut-http-java': freezeProfile({
		id: 'micronaut-http-java',
		language: 'java',
		status: 'profile-only',
		requiredFacts: [
			'syntax.top-level-types', 'syntax.imports', 'syntax.annotations',
			'method.direct', 'annotation.resolve', 'annotation.meta-graph',
		],
		entryAnnotations: [
			'io.micronaut.http.annotation.Controller',
		],
		routeAnnotations: {
			'io.micronaut.http.annotation.Get': 'GET',
			'io.micronaut.http.annotation.Post': 'POST',
			'io.micronaut.http.annotation.Put': 'PUT',
			'io.micronaut.http.annotation.Patch': 'PATCH',
			'io.micronaut.http.annotation.Delete': 'DELETE',
		},
		knownBlockers: [
			'compile-time generated metadata is not inferred from source alone',
			'conditional beans and environment-specific routes need separately approved runtime evidence',
		],
	}),
	'ktor-kotlin': freezeProfile({
		id: 'ktor-kotlin',
		language: 'kotlin',
		status: 'blocked-language-profile',
		requiredFacts: [],
		entryAnnotations: [],
		routeAnnotations: {},
		knownBlockers: [
			'T05 draft language protocol currently accepts Java only',
			'Ktor routing is a Kotlin DSL and must not be approximated by Java annotation rules',
		],
	}),
});

export function getJvmFrameworkProfile(id) {
	const profile = JVM_FRAMEWORK_PROFILES[id];
	if (!profile) throw new Error('unknown JVM framework profile: ' + id);
	return profile;
}

export function validateJvmFrameworkProfile(profile) {
	const errors = [];
	if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
		return { ok: false, errors: ['profile must be an object'] };
	}
	if (typeof profile.id !== 'string' || profile.id.length === 0) errors.push('id must be non-empty');
	if (!['java', 'kotlin'].includes(profile.language)) errors.push('language must be java or kotlin');
	if (!['shadow-ready', 'profile-only', 'blocked-language-profile'].includes(profile.status)) errors.push('unsupported profile status');
	if (!Array.isArray(profile.requiredFacts)) errors.push('requiredFacts must be an array');
	else for (const fact of profile.requiredFacts) if (!FACT_CAPABILITIES.has(fact)) errors.push('unknown fact capability: ' + fact);
	if (!Array.isArray(profile.entryAnnotations)) errors.push('entryAnnotations must be an array');
	if (profile.routeAnnotations === null || typeof profile.routeAnnotations !== 'object' || Array.isArray(profile.routeAnnotations)) errors.push('routeAnnotations must be an object');
	if (!Array.isArray(profile.knownBlockers)) errors.push('knownBlockers must be an array');
	if (Object.hasOwn(profile, 'allowTargetExecution')) errors.push('framework profile must not grant target execution');
	return { ok: errors.length === 0, errors };
}

export function assessJvmFrameworkProfile(id, availableFacts) {
	const profile = getJvmFrameworkProfile(id);
	const available = new Set(availableFacts ?? []);
	const missingFacts = profile.requiredFacts.filter((fact) => !available.has(fact));
	const languageBlocked = profile.language !== 'java';
	return {
		id,
		status: languageBlocked ? 'blocked' : missingFacts.length ? 'incomplete' : 'facts-ready',
		missingFacts,
		knownBlockers: [...profile.knownBlockers],
		semanticAdapterImplemented: false,
		runtimeVerified: false,
	};
}