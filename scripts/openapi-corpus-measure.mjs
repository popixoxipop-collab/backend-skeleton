#!/usr/bin/env node
// ROADMAP.md Phase 5c (D-oracle-corpus-openapi-remeasurement): re-derives every real,
// Team-IZ-Backend-oracle-measured constant in contracts/openapi.mjs/contracts/export.mjs against
// a SECOND (or third) real OpenAPI document, now that Phase 5b's oracle corpus made that possible
// (2 of its 13 repos ship a real, checked-in OpenAPI document: polarsource/polar and
// 1chz/realworld-java21-springboot3).
//
// Reuses contracts/openapi.mjs's own exported findUnsupportedAnnotations()/indexOpenApiDocument()/
// inlineSchema() directly -- this is the EXACT production code path, not a reimplementation, for
// every metric that function already computes. Metrics with no existing exported equivalent
// (max parameters/operation, description/example length, the format-value histogram, component-
// schema-name regex validity) are computed here with straightforward, single-pass walks over the
// raw parsed document, each labeled with the exact original Team-IZ-Backend comment it re-checks.
//
// Usage: node scripts/openapi-corpus-measure.mjs <path-to-openapi.json-or-.yaml>
//
// Prints a JSON report to stdout. Never wired into test:all-smoke/CI -- same reasoning as
// scripts/shadow-validation-smoke.mjs: this needs a real, external OpenAPI document (often
// megabytes, e.g. polarsource/polar's is ~2.7MB) this repo does not own or vendor. A human runs
// this by hand against a locally downloaded document; see DECISIONS.md's
// D-oracle-corpus-openapi-remeasurement for the real numbers already gathered this way.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { findUnsupportedAnnotations, indexOpenApiDocument, inlineSchema, COMPONENT_SCHEMA_NAME_RE, SCHEMA_PROPERTY_NAME_RE } from '../contracts/openapi.mjs';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function fail(message) {
	console.error(`openapi-corpus-measure: FAIL -- ${message}`);
	process.exit(1);
}

const filePath = process.argv[2];
if (!filePath) fail('usage: node scripts/openapi-corpus-measure.mjs <path-to-openapi.json-or-.yaml>');

const raw = fs.readFileSync(filePath, 'utf8');
const doc = /\.ya?ml$/i.test(filePath) ? YAML.parse(raw) : JSON.parse(raw);

function* allOperations(doc) {
	const paths = doc.paths;
	if (!paths || typeof paths !== 'object') return;
	for (const item of Object.values(paths)) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
		for (const [verb, operation] of Object.entries(item)) {
			if (!HTTP_METHODS.has(verb) || !operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
			yield operation;
		}
	}
}

function utf8Bytes(s) {
	return Buffer.byteLength(s, 'utf8');
}

// --- per-operation caps: parameters, responses, security requirements, request media types ---
let maxParameters = { value: 0, operationId: null };
let maxResponses = { value: 0, operationId: null };
let maxSecurityRequirements = { value: 0, operationId: null };
let maxRequestMediaTypes = { value: 0, operationId: null };
let operationsTotal = 0;
let operationsWithDescription = 0;
let maxOperationDescription = { length: 0, bytes: 0, operationId: null };

for (const op of allOperations(doc)) {
	operationsTotal++;
	const opId = op.operationId ?? '(no operationId)';

	const paramCount = Array.isArray(op.parameters) ? op.parameters.length : 0;
	if (paramCount > maxParameters.value) maxParameters = { value: paramCount, operationId: opId };

	const responseCount = op.responses && typeof op.responses === 'object' ? Object.keys(op.responses).length : 0;
	if (responseCount > maxResponses.value) maxResponses = { value: responseCount, operationId: opId };

	const securityArr = Array.isArray(op.security) ? op.security : (Array.isArray(doc.security) ? doc.security : []);
	if (securityArr.length > maxSecurityRequirements.value) maxSecurityRequirements = { value: securityArr.length, operationId: opId };

	const mediaTypeCount = op.requestBody?.content && typeof op.requestBody.content === 'object' ? Object.keys(op.requestBody.content).length : 0;
	if (mediaTypeCount > maxRequestMediaTypes.value) maxRequestMediaTypes = { value: mediaTypeCount, operationId: opId };

	if (typeof op.description === 'string' && op.description.length > 0) {
		operationsWithDescription++;
		if (op.description.length > maxOperationDescription.length) {
			maxOperationDescription = { length: op.description.length, bytes: utf8Bytes(op.description), operationId: opId };
		}
	}
}

// --- component schemas: count + COMPONENT_SCHEMA_NAME_RE/SCHEMA_PROPERTY_NAME_RE validity ---
const componentSchemas = doc.components?.schemas && typeof doc.components.schemas === 'object' ? doc.components.schemas : {};
const componentSchemaNames = Object.keys(componentSchemas);
const rejectedComponentNames = componentSchemaNames.filter((n) => !COMPONENT_SCHEMA_NAME_RE.test(n));

const rejectedPropertyNames = [];
let maxPatternLength = { value: 0, where: null };
let maxExampleLength = { value: 0, where: null };
const formatHistogram = {};

function walkForPatternsExamplesProps(node, whereLabel, seen = new Set()) {
	if (!node || typeof node !== 'object' || seen.has(node)) return;
	seen.add(node);
	if (Array.isArray(node)) {
		for (const item of node) walkForPatternsExamplesProps(item, whereLabel, seen);
		return;
	}
	if (typeof node.pattern === 'string' && node.pattern.length > maxPatternLength.value) {
		maxPatternLength = { value: node.pattern.length, where: whereLabel };
	}
	if (typeof node.format === 'string') {
		formatHistogram[node.format] = (formatHistogram[node.format] ?? 0) + 1;
	}
	if (Object.hasOwn(node, 'example')) {
		const len = JSON.stringify(node.example).length;
		if (len > maxExampleLength.value) maxExampleLength = { value: len, where: whereLabel };
	}
	if (node.properties && typeof node.properties === 'object') {
		for (const propName of Object.keys(node.properties)) {
			if (!SCHEMA_PROPERTY_NAME_RE.test(propName)) rejectedPropertyNames.push(propName);
		}
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === 'example') continue; // already measured as a whole value above, don't recurse into it
		walkForPatternsExamplesProps(value, whereLabel, seen);
	}
}

for (const [name, schema] of Object.entries(componentSchemas)) {
	walkForPatternsExamplesProps(schema, `components.schemas.${name}`);
}
for (const op of allOperations(doc)) {
	walkForPatternsExamplesProps(op.requestBody, `${op.operationId ?? '(no operationId)'}.requestBody`);
	walkForPatternsExamplesProps(op.responses, `${op.operationId ?? '(no operationId)'}.responses`);
	walkForPatternsExamplesProps(op.parameters, `${op.operationId ?? '(no operationId)'}.parameters`);
}

// --- findUnsupportedAnnotations: the direct re-check of the "permanently unbuilt" claim ---
const unsupportedAnnotationsFound = findUnsupportedAnnotations(doc);

// --- security schemes, document-wide ---
const securitySchemeCount = doc.components?.securitySchemes && typeof doc.components.securitySchemes === 'object' ? Object.keys(doc.components.securitySchemes).length : 0;

// --- response-schema $ref count, non-JSON response media types, response headers ---
let responseObjectsTotal = 0;
let responseObjectsWithRef = 0;
let nonJsonResponseMediaTypes = new Set();
let responseObjectsWithHeaders = 0;
for (const op of allOperations(doc)) {
	if (!op.responses || typeof op.responses !== 'object') continue;
	for (const resp of Object.values(op.responses)) {
		if (!resp || typeof resp !== 'object') continue;
		responseObjectsTotal++;
		if (Object.hasOwn(resp, '$ref')) responseObjectsWithRef++;
		if (resp.headers && typeof resp.headers === 'object' && Object.keys(resp.headers).length > 0) responseObjectsWithHeaders++;
		if (resp.content && typeof resp.content === 'object') {
			for (const mediaType of Object.keys(resp.content)) {
				if (mediaType !== 'application/json') nonJsonResponseMediaTypes.add(mediaType);
			}
		}
	}
}

// --- real inlineSchema() resolution success rate over every real request/response schema root ---
const indexed = indexOpenApiDocument(doc);
const inlineResults = { attempted: 0, ok: 0, failReasons: {}, maxNodesOk: 0 };
function tryInline(schemaNode, label) {
	if (!schemaNode || typeof schemaNode !== 'object') return;
	inlineResults.attempted++;
	// inlineSchema() (contracts/openapi.mjs) returns {ok, schema, nodes} on success -- no depth
	// value, so this report only tracks node counts, not depth, among successful resolutions.
	const result = inlineSchema(schemaNode, indexed.componentSchemas ?? new Map());
	if (result.ok) {
		inlineResults.ok++;
		if (result.nodes > inlineResults.maxNodesOk) inlineResults.maxNodesOk = result.nodes;
	} else {
		inlineResults.failReasons[result.reason] = (inlineResults.failReasons[result.reason] ?? 0) + 1;
	}
}
for (const op of allOperations(doc)) {
	const reqSchema = op.requestBody?.content?.['application/json']?.schema;
	if (reqSchema) tryInline(reqSchema, `${op.operationId ?? '?'}.requestBody`);
	if (op.responses && typeof op.responses === 'object') {
		for (const [status, resp] of Object.entries(op.responses)) {
			const respSchema = resp?.content?.['application/json']?.schema;
			if (respSchema) tryInline(respSchema, `${op.operationId ?? '?'}.responses.${status}`);
		}
	}
}

const report = {
	file: path.basename(filePath),
	componentSchemas: { count: componentSchemaNames.length, rejectedByComponentSchemaNameRe: rejectedComponentNames },
	rejectedBySchemaPropertyNameRe: [...new Set(rejectedPropertyNames)],
	operations: { total: operationsTotal, withNonEmptyDescription: operationsWithDescription },
	maxParametersPerOperation: maxParameters,
	maxResponsesPerOperation: maxResponses,
	maxSecurityRequirementsPerOperation: maxSecurityRequirements,
	securitySchemesDocumentWide: securitySchemeCount,
	maxRequestMediaTypesPerOperation: maxRequestMediaTypes,
	maxOperationDescriptionLength: maxOperationDescription,
	maxPatternLength,
	maxExampleLength,
	formatHistogram,
	unsupportedAnnotationsFound,
	responseObjects: { total: responseObjectsTotal, withRef: responseObjectsWithRef, withHeaders: responseObjectsWithHeaders, nonJsonMediaTypes: [...nonJsonResponseMediaTypes] },
	inlineSchemaResolution: inlineResults,
};

console.log(JSON.stringify(report, null, 2));
