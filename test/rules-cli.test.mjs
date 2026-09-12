// D-business-rules: CLI-level coverage through the real `bskel` binary against a real fixture
// repo -- real preflight, real `contract emit --openapi-file`, real gate state on disk. The rule
// semantics themselves are unit-tested in test/rules-compile.test.mjs; this file covers the
// wiring: gating, refusal-writes-nothing, the gate's own inputs, and the artifact actually
// validating against its schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	buildFixtureRepo, initThroughScanDisposition, widgetOpenApiDoc, writeOpenApiFixture,
	run, runCapturingStderr,
} from './_contract-fixture.mjs';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';

const FEATURE = '001-widget-management';

// A request body with enough shape to exercise all three predicate kinds: a length-constrained
// string, a bounded integer, an enum (the only thing a transition rule can target), and two
// same-typed strings to compare against each other. Built by mutating widgetOpenApiDoc()'s own
// output rather than adding a flag to the shared fixture -- keeps every existing assertion in
// every other test file byte-for-byte untouched.
function richOpenApiDoc() {
	const doc = widgetOpenApiDoc({ withRequestBodies: true });
	doc.components.schemas.CreateWidgetRequest = {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string', maxLength: 10, minLength: 2 },
			qty: { type: 'integer', minimum: 1 },
			status: { type: 'string', enum: ['draft', 'published'] },
			startDate: { type: 'string' },
			endDate: { type: 'string' },
		},
	};
	return doc;
}

function repoThroughContract({ rich = true } = {}) {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const file = writeOpenApiFixture(root, rich ? richOpenApiDoc() : widgetOpenApiDoc({ withRequestBodies: true }));
	const emitted = run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', file], root);
	assert.equal(emitted.code, 0, `contract emit failed: ${emitted.stderr ?? ''}`);
	return root;
}

function writeRules(root, yaml) {
	fs.mkdirSync(path.join(root, 'specs', FEATURE), { recursive: true });
	fs.writeFileSync(path.join(root, 'specs', FEATURE, 'rules.yaml'), yaml);
}

function artifactPath(root) {
	return path.join(root, 'specs', FEATURE, 'rules', `${FEATURE}.rules.json`);
}

const VALID_RULES = `schema: sbf.feature-rules-source/1
rules:
  - id: date-order
    kind: cross
    operation: createWidget
    pointers: [/startDate, /endDate]
    assert: lt
    reason: "a widget cannot end before it starts"
  - id: publish-flow
    kind: transition
    operation: createWidget
    pointer: /status
    from: [draft]
    to: [published]
    reason: "only a draft may be published"
  - id: qty-cap
    kind: field
    operation: createWidget
    pointer: /qty
    assert: maximum
    value: 500
    reason: "internal policy cap, deliberately not in the public API schema"
`;

// ---- R4: the zero-authoring path ------------------------------------------------------------

test('R4: with NO rules.yaml at all, `rules check` still compiles real rules out of the contract\'s own OpenAPI constraints', () => {
	const root = repoThroughContract();
	const r = run(['rules', 'check', '--feature', FEATURE, '--json'], root);
	assert.equal(r.code, 0, r.stderr);
	const doc = JSON.parse(r.stdout);
	// maxLength + minLength on /name, minimum on /qty, enum on /status -- four facts the user's
	// own document already asserted, transported. Nothing authored, nothing invented.
	assert.equal(doc.summary.fromContract, 4);
	assert.equal(doc.summary.declared, 0);
	assert.equal(doc.gate.status, 'pass');
	assert.ok(fs.existsSync(artifactPath(root)));
});

test('every contract-projected rule carries origin "contract", and none of them duplicates required/type/pattern', () => {
	const root = repoThroughContract();
	run(['rules', 'check', '--feature', FEATURE], root);
	const artifact = JSON.parse(fs.readFileSync(artifactPath(root), 'utf8'));
	const field = artifact.operations.createWidget.field;
	assert.ok(field.every((r) => r.origin === 'contract'));
	assert.equal(field.some((r) => ['required', 'type', 'pattern'].includes(r.assert)), false);
});

// ---- authored rules ---------------------------------------------------------------------------

test('authored rules compile alongside contract-projected ones, staying distinguishable by origin', () => {
	const root = repoThroughContract();
	writeRules(root, VALID_RULES);
	const r = run(['rules', 'check', '--feature', FEATURE, '--json'], root);
	assert.equal(r.code, 0, r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.summary.declared, 3);
	assert.equal(doc.summary.fromContract, 4);
	assert.equal(doc.summary.cross, 1);
	assert.equal(doc.summary.transition, 1);
});

test('the compiled artifact validates against schemas/feature-rules.schema.json (schema-accuracy bridge)', () => {
	const root = repoThroughContract();
	writeRules(root, VALID_RULES);
	run(['rules', 'check', '--feature', FEATURE], root);
	const artifact = JSON.parse(fs.readFileSync(artifactPath(root), 'utf8'));
	const { ok, errors } = validateAgainstSchema('feature-rules.schema.json', artifact);
	assert.ok(ok, `a real compiled artifact must match its own schema:\n${ok ? '' : formatSchemaErrors(errors).join('\n')}`);
});

test('the artifact pins contract_ref to the real contract file hash, so a rules/contract mismatch is detectable', () => {
	const root = repoThroughContract();
	run(['rules', 'check', '--feature', FEATURE], root);
	const artifact = JSON.parse(fs.readFileSync(artifactPath(root), 'utf8'));
	const gate = JSON.parse(run(['gate', 'show', 'rules', '--feature', FEATURE], root).stdout);
	assert.equal(artifact.contract_ref, gate.record.inputs.contract_hash);
	assert.match(artifact.contract_ref, /^[0-9a-f]{64}$/);
});

// ---- R6: refusal ------------------------------------------------------------------------------

test('R6: a rule naming a non-existent operation is refused at exit 14 and writes NOTHING', () => {
	const root = repoThroughContract();
	writeRules(root, `schema: sbf.feature-rules-source/1
rules:
  - id: bogus
    kind: field
    operation: noSuchOperation
    pointer: /name
    assert: maxLength
    value: 5
`);
	const r = run(['rules', 'check', '--feature', FEATURE], root);
	assert.equal(r.code, 14);
	assert.match(r.stderr, /RULE_UNKNOWN_OPERATION/);
	assert.match(r.stderr, /known operations: createWidget/);
	assert.match(r.stderr, /nothing was written/);
	assert.equal(fs.existsSync(artifactPath(root)), false, 'a refused compile must leave no artifact behind');
});

test('R6: a refusal leaves the rules gate un-passed, so the failure cannot be mistaken for success', () => {
	const root = repoThroughContract();
	writeRules(root, `schema: sbf.feature-rules-source/1
rules:
  - id: wrong-type
    kind: field
    operation: createWidget
    pointer: /qty
    assert: maxLength
    value: 5
`);
	assert.equal(run(['rules', 'check', '--feature', FEATURE], root).code, 14);
	const gate = run(['gate', 'require', 'rules', '--feature', FEATURE], root);
	assert.notEqual(gate.code, 0, 'the rules gate must not read as passed after a refusal');
});

test('R6: a malformed rules.yaml (bad top-level schema key) is refused with a pointer to the right value', () => {
	const root = repoThroughContract();
	writeRules(root, 'rules: []\n');
	const r = run(['rules', 'check', '--feature', FEATURE], root);
	assert.equal(r.code, 14);
	assert.match(r.stderr, /expected `schema: sbf\.feature-rules-source\/1`/);
});

test('R6: invalid YAML is refused as a usage error, not an uncaught throw', () => {
	const root = repoThroughContract();
	writeRules(root, 'schema: [unclosed\n');
	const r = run(['rules', 'check', '--feature', FEATURE], root);
	assert.equal(r.code, 14);
	assert.match(r.stderr, /not valid YAML/);
});

// ---- gating -----------------------------------------------------------------------------------

test('`rules check` is gated on the contract gate having passed -- rules are verified against the contract, so an unaccepted one must not be baked in', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const r = run(['rules', 'check', '--feature', FEATURE], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /`contract` gate/);
});

test('re-emitting the contract stales the rules gate -- a compiled rule is only meaningful against the contract it was verified against', () => {
	const root = repoThroughContract();
	run(['rules', 'check', '--feature', FEATURE], root);
	assert.equal(run(['gate', 'require', 'rules', '--feature', FEATURE], root).code, 0);

	// A genuinely different contract: same fixture, but the document now also documents DELETE.
	const changed = writeOpenApiFixture(root, { ...richOpenApiDoc(), ...widgetOpenApiDoc({ withRequestBodies: true, includeDeleteWidget: true }) });
	run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', changed], root);
	const after = run(['gate', 'require', 'rules', '--feature', FEATURE], root);
	assert.notEqual(after.code, 0, 'the rules gate must go stale when the contract it was checked against moves');
});

// ---- --init ------------------------------------------------------------------------------------

test('--init writes a starter rules.yaml that contains ZERO live rules -- a real one would be bskel inventing a domain constraint', () => {
	const root = repoThroughContract();
	const r = run(['rules', 'check', '--feature', FEATURE, '--init', '--json'], root);
	assert.equal(r.code, 0, r.stderr);
	const yaml = fs.readFileSync(path.join(root, 'specs', FEATURE, 'rules.yaml'), 'utf8');
	assert.match(yaml, /^rules: \[\]$/m);
	assert.equal(JSON.parse(r.stdout).summary.declared, 0);
});

test('--init refuses to overwrite an existing rules.yaml', () => {
	const root = repoThroughContract();
	writeRules(root, VALID_RULES);
	const r = run(['rules', 'check', '--feature', FEATURE, '--init'], root);
	assert.equal(r.code, 14);
	assert.match(r.stderr, /refuses to overwrite/);
	assert.equal(fs.readFileSync(path.join(root, 'specs', FEATURE, 'rules.yaml'), 'utf8'), VALID_RULES, 'the existing file must be untouched');
});

// ---- honesty: unsupported constraints are reported, on stderr ------------------------------------

test('a contract constraint this vocabulary cannot enforce is reported on stderr even on a successful (exit 0) run', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withRequestBodies: true });
	doc.components.schemas.CreateWidgetRequest = {
		type: 'object',
		properties: { tags: { type: 'array', items: { type: 'string' } } },
	};
	const file = writeOpenApiFixture(root, doc);
	run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', file], root);
	// execFileSync drops stderr on a zero exit -- this project's own documented trap, which is
	// exactly why _contract-fixture.mjs exposes a spawnSync-based helper for this case.
	const r = runCapturingStderr(['rules', 'check', '--feature', FEATURE], root);
	assert.equal(r.code, 0);
	assert.match(r.stderr, /NOT enforced/);
	assert.match(r.stderr, /RULE_NON_SCALAR_TARGET/);
});

// ---- read-only verbs -----------------------------------------------------------------------------

test('`rules list` renders every kind with its origin, and writes nothing', () => {
	const root = repoThroughContract();
	writeRules(root, VALID_RULES);
	run(['rules', 'check', '--feature', FEATURE], root);
	const before = fs.readFileSync(artifactPath(root), 'utf8');
	const r = run(['rules', 'list', '--feature', FEATURE], root);
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /\[field\].*qty-cap/);
	assert.match(r.stdout, /\[cross\].*date-order/);
	assert.match(r.stdout, /\[transition\].*publish-flow/);
	assert.match(r.stdout, /\(contract\)/);
	assert.equal(fs.readFileSync(artifactPath(root), 'utf8'), before, 'a read-only verb must not rewrite the artifact');
});

test('`rules explain` renders a rule as a sentence and distinguishes a contract-projected rule from a declared one', () => {
	const root = repoThroughContract();
	writeRules(root, VALID_RULES);
	run(['rules', 'check', '--feature', FEATURE], root);

	const declared = run(['rules', 'explain', '--feature', FEATURE, '--rule', 'date-order'], root);
	assert.equal(declared.code, 0, declared.stderr);
	assert.match(declared.stdout, /\/startDate must be < \/endDate/);
	assert.match(declared.stdout, /declared in rules\.yaml/);

	const projected = run(['rules', 'explain', '--feature', FEATURE, '--rule', 'contract:createWidget:name:maxLength'], root);
	assert.equal(projected.code, 0, projected.stderr);
	assert.match(projected.stdout, /change the OpenAPI document, not rules\.yaml/);
});

test('`rules explain` on an unknown id names the known rule ids instead of failing blankly', () => {
	const root = repoThroughContract();
	run(['rules', 'check', '--feature', FEATURE], root);
	const r = run(['rules', 'explain', '--feature', FEATURE, '--rule', 'nope'], root);
	assert.equal(r.code, 14);
	assert.match(r.stderr, /known rule ids: .*contract:createWidget/);
});

test('`rules list`/`explain` before any `rules check` point at the command that would fix it', () => {
	const root = repoThroughContract();
	const r = run(['rules', 'list', '--feature', FEATURE], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /run `bskel rules check --feature 001-widget-management` first/);
});

// ---- determinism ----------------------------------------------------------------------------------

test('a second `rules check` with nothing changed leaves the artifact byte-identical', () => {
	const root = repoThroughContract();
	writeRules(root, VALID_RULES);
	run(['rules', 'check', '--feature', FEATURE], root);
	const first = fs.readFileSync(artifactPath(root), 'utf8');
	run(['rules', 'check', '--feature', FEATURE], root);
	assert.equal(fs.readFileSync(artifactPath(root), 'utf8'), first);
});

// ---- R5/Phase 3: derived fields --------------------------------------------------------------

test('R5: a derived rule compiles resource-scoped, alongside predicate rules, and is counted in the summary', () => {
	const root = repoThroughContract();
	writeRules(root, `schema: sbf.feature-rules-source/1
rules:
  - id: order-total
    kind: derived
    resource: Order
    field: total
    expr:
      op: sub
      args:
        - op: mul
          args: [{ ref: price }, { ref: quantity }]
        - { ref: discount }
    reason: "policy: total = price*qty - discount"
`);
	const r = run(['rules', 'check', '--feature', FEATURE, '--json'], root);
	assert.equal(r.code, 0, r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.summary.derived, 1);
	const artifact = JSON.parse(fs.readFileSync(artifactPath(root), 'utf8'));
	assert.deepEqual(artifact.derived, [{
		id: 'order-total', resource: 'Order', field: 'total', params: ['price', 'quantity', 'discount'],
		expr: { op: 'sub', args: [{ op: 'mul', args: [{ ref: 'price' }, { ref: 'quantity' }] }, { ref: 'discount' }] },
		origin: 'declared',
	}]);
});

test('R5: a self-referencing derived rule is refused, writes nothing, and the rules gate stays un-passed', () => {
	const root = repoThroughContract();
	writeRules(root, `schema: sbf.feature-rules-source/1
rules:
  - id: bad
    kind: derived
    resource: Order
    field: total
    expr: { ref: total }
`);
	const r = run(['rules', 'check', '--feature', FEATURE], root);
	assert.equal(r.code, 14);
	assert.match(r.stderr, /RULE_DERIVED_SELF_REFERENCE/);
	assert.equal(fs.existsSync(artifactPath(root)), false);
	assert.notEqual(run(['gate', 'require', 'rules', '--feature', FEATURE], root).code, 0);
});

test('`rules list` renders a derived rule under its own resource-scoped section', () => {
	const root = repoThroughContract();
	writeRules(root, `schema: sbf.feature-rules-source/1
rules:
  - id: order-total
    kind: derived
    resource: Order
    field: total
    expr: { op: mul, args: [{ ref: price }, { ref: quantity }] }
`);
	run(['rules', 'check', '--feature', FEATURE], root);
	const r = run(['rules', 'list', '--feature', FEATURE], root);
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /\[derived\]\s+order-total\s+Order\.total <- \(price, quantity\)/);
});

test('`rules explain` on a derived rule id names its resource/field/params instead of an operation', () => {
	const root = repoThroughContract();
	writeRules(root, `schema: sbf.feature-rules-source/1
rules:
  - id: order-total
    kind: derived
    resource: Order
    field: total
    expr: { op: mul, args: [{ ref: price }, { ref: quantity }] }
`);
	run(['rules', 'check', '--feature', FEATURE], root);
	const r = run(['rules', 'explain', '--feature', FEATURE, '--rule', 'order-total'], root);
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /resource:\s+Order\.total/);
	assert.match(r.stdout, /kind:\s+derived/);
});
