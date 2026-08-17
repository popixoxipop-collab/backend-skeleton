// G1: the fixed capability vocabulary a scanner adapter can declare support for, and which
// capabilities a CLI command needs before it's allowed to run adapter-specific codegen. Adding a
// capability here touches zero adapter files (an adapter that doesn't mention it is `false` by
// construction, via schemas/adapter.schema.json's additionalProperties:{type:'boolean'} +
// fail-closed reads elsewhere) -- and adding an adapter never touches this file. See
// D-adapter-registry in DECISIONS.md.
export const CAPABILITIES = Object.freeze({
	'api.operations': {
		summary: 'endpoints carry a source-pinned, non-null operationId',
		why: 'a contract operation must be addressable by id -- generic-grep\'s route-pattern grep never correlates one (operationId is always null by construction, see D-generic-grep-reconnaissance in DECISIONS.md)',
	},
	'api.request-shape': {
		summary: '`controller.file` + `ep.method` are present and re-readable as source, so request-body shape is derivable',
		why: 'declared for documentation, not enforced -- its absence already degrades gracefully to body: "unknown" (see contracts/emit.mjs)',
	},
	'resource.fetch': {
		summary: 'the IR carries persistence entities (table/idField) and a canonical single-resource GET is identifiable',
		why: 'handle codegen needs to know what to fetch, and by what key',
	},
	'codegen.handles': {
		summary: 'a handle codegen provider exists for this adapter\'s stack',
		why: 'only the java-spring provider exists today -- see G4 in CATALOG.md',
	},
});

export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITIES));

// Which capabilities a command needs before it's allowed to touch adapter-specific codegen, and
// which gate (if any) a human can `bskel gate force` past once they've hand-supplied the missing
// artifact themselves.
export const COMMAND_CAPABILITIES = Object.freeze({
	'contract emit': Object.freeze(['api.operations']),
	'handles plan': Object.freeze(['resource.fetch', 'codegen.handles']),
	'handles emit': Object.freeze(['resource.fetch', 'codegen.handles']),
});

export const COMMAND_GATE = Object.freeze({
	'contract emit': 'contract',
	'handles plan': 'handles',
	'handles emit': 'handles',
});

// G2: data, not a per-adapter special case -- a capability a weak adapter can't earn statically
// can still be legitimately satisfied by an explicit CLI flag that supplies the missing ground
// truth from elsewhere. Today's one instance: `api.operations` (a real OpenAPI document supplies
// operation identity a static scan of e.g. python-fastapi honestly cannot -- see D-fastapi-adapter
// in DECISIONS.md). Expressed here, once, as a frozen map keyed by capability -- so
// `requireCapabilitiesOrExit()` and `explainMissingCapability()` never need to know which
// ADAPTER this applies to. Any adapter (including a future one) with the same honest weakness
// benefits automatically; this is deliberately NOT java-spring/python-fastapi-specific.
export const CAPABILITY_SATISFIERS = Object.freeze({
	'api.operations': {
		flag: 'openapi-file',
		note: 'a real OpenAPI document can supply operation identity a weak adapter cannot derive statically -- ' +
			'retry with --openapi-file <path> (and --path-prefix <prefix>, if this repo applies a global prefix ' +
			'the document\'s own paths already include but this adapter could not resolve on its own -- ' +
			'otherwise every endpoint stays unresolved with reason "prefix-inconclusive", see ' +
			'D-openapi-reconciliation in DECISIONS.md)',
	},
});

// Pure and exported so a test can assert the message shape without shelling out. `scanReportPath`
// is an absolute path, matching this codebase's existing "no scan report at <abs path>"-style
// messages (bin/bskel.mjs's loadScanReportOrExit).
export function explainMissingCapability({ adapterId, capability, command, featureId, scanReportPath }) {
	const cap = CAPABILITIES[capability];
	const gate = COMMAND_GATE[command];
	const satisfier = CAPABILITY_SATISFIERS[capability];
	const lines = [
		`blocked: \`bskel ${command}\` requires the \`${capability}\` capability, which the \`${adapterId}\` ` +
			`adapter -- the adapter that produced ${scanReportPath} -- does not declare.`,
		'',
		`  ${capability}: ${cap.summary}. ${cap.why}.`,
		'',
		'Nothing was written.',
		'',
		'What you can do:',
	];
	if (satisfier) lines.push(`  - ${satisfier.note}.`);
	lines.push('  - run `bskel doctor` -- it reports why each installed adapter did or did not detect this repo.');
	lines.push(`  - hand-write the required artifact against its schema yourself, then \`bskel gate force ${gate} --feature ${featureId} --reason "..."\` if you're confident it's correct.`);
	lines.push('  - no adapter/codegen provider exists for this stack yet -- see G2/G4 in CATALOG.md.');
	return lines.join('\n');
}
