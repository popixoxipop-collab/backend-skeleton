// P2 (D-greenfield-bootstrap): a plain dispatch map, NOT scanners/registry.mjs's/handles/
// registry.mjs's dynamic-load-and-validate machinery -- those exist for genuine THIRD-PARTY
// extensibility (G1/G4's explicit design goal, a schema-validated contract other adapters/
// providers can implement). `bskel new`'s two stacks are first-party-only with no such need; a
// simple object map is the honest amount of structure for two fixed choices, not an
// under-justified copy of a pattern built for a different problem.
import { scaffoldSpring } from './spring.mjs';
import { scaffoldFastapi } from './fastapi.mjs';

export const STACKS = Object.freeze({
	spring: { id: 'spring', scaffold: scaffoldSpring, requiresNetwork: true },
	fastapi: { id: 'fastapi', scaffold: scaffoldFastapi, requiresNetwork: false },
});
