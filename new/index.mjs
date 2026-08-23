// P2 (D-greenfield-bootstrap): a plain dispatch map, NOT scanners/registry.mjs's/handles/
// registry.mjs's dynamic-load-and-validate machinery -- those exist for genuine THIRD-PARTY
// extensibility (G1/G4's explicit design goal, a schema-validated contract other adapters/
// providers can implement). `bskel new`'s two stacks are first-party-only with no such need; a
// simple object map is the honest amount of structure for two fixed choices, not an
// under-justified copy of a pattern built for a different problem.
//
// P2b (D-greenfield-parameters): the record shape is WIDER (each stack now declares which
// parameters it accepts and which it explicitly refuses), and deliberately still a plain object.
// The reason two first-party stacks don't justify a registry hasn't changed just because each entry
// grew three fields.
import { scaffoldSpring } from './spring.mjs';
import { scaffoldFastapi } from './fastapi.mjs';

// Parameters describing the generated project itself, meaningful to any stack.
const COMMON_PARAMS = ['name', 'description', 'project-version'];

// P2b: three Spring Initializr parameters this tool refuses OUTRIGHT rather than passing through --
// each for a specific, cited reason about what would break downstream, not "not supported yet".
// Declared here (rather than simply left undeclared) so a user who reasonably expects them -- they
// are all real controls on start.spring.io's own web UI -- gets the reason instead of a bare
// "unknown option". They are `hidden` in lib/cli.mjs's COMMANDS table, so they stay out of --help
// and out of the usage()<->COMMANDS drift test, exactly the mechanism `scan --db` used while it was
// a documented-but-inert placeholder.
const SPRING_REFUSED_PARAMS = Object.freeze({
	type: '--type is not supported: `bskel new --stack spring` always requests a Gradle-Groovy project. handles/providers/java-spring/emit.mjs\'s detectJacksonPackage() reads build.gradle ONLY and falls back to the Jackson 2 package when it is absent -- a Maven (pom.xml) or Kotlin-DSL (build.gradle.kts) scaffold would therefore make a later `bskel handles emit` generate code importing com.fasterxml.jackson.databind.ObjectMapper, which is not on the classpath under Initializr\'s current default Spring Boot 4 (Jackson 3). A project that scaffolds fine and then fails to compile is worse than a refusal.',
	language: '--language is not supported: `bskel new --stack spring` always requests Java. scanners/adapters/java-spring.mjs\'s listJavaFiles() globs *.java only and detectJavaSpringRoot() requires src/main/java, and every handles/providers/java-spring template emits .java -- a Kotlin or Groovy scaffold would fall straight through to the generic-grep fallback adapter (specificity 0, confidence "low", no codegen provider at all).',
	'boot-version': '--boot-version is not supported: start.spring.io answers an unknown bootVersion with HTTP 500 and an internal Spring config-class error, which is not something worth surfacing to you, and pinning an exact Boot version is a maintenance liability this tool already argued against (see D-greenfield-bootstrap -- Initializr only serves actively-supported versions and ages old ones out on its own schedule, and detectJacksonPackage() already adapts to whichever major version comes back).',
});

export const STACKS = Object.freeze({
	spring: Object.freeze({
		id: 'spring',
		scaffold: scaffoldSpring,
		requiresNetwork: true,
		acceptedParams: Object.freeze([
			...COMMON_PARAMS,
			'group-id', 'artifact-id', 'package-name', 'java-version', 'packaging',
			'dependencies', 'add-dependencies',
		]),
		refusedParams: SPRING_REFUSED_PARAMS,
	}),
	fastapi: Object.freeze({
		id: 'fastapi',
		scaffold: scaffoldFastapi,
		requiresNetwork: false,
		acceptedParams: Object.freeze([...COMMON_PARAMS, 'python-version', 'port', 'license', 'database']),
		refusedParams: Object.freeze({}),
	}),
});

// Every parameter any stack knows about -- the set cmdNew checks a passed flag against to decide
// "wrong stack" vs. "not a stack parameter at all". Derived, never a hand-maintained third list.
export const ALL_STACK_PARAMS = Object.freeze([...new Set(
	Object.values(STACKS).flatMap((s) => [...s.acceptedParams, ...Object.keys(s.refusedParams)]),
)]);

// Which stack DOES accept a given parameter -- so a cross-stack rejection can name the right one
// ("--group-id applies to --stack spring") instead of just saying no.
export function stacksAccepting(param) {
	return Object.values(STACKS).filter((s) => s.acceptedParams.includes(param)).map((s) => s.id);
}
