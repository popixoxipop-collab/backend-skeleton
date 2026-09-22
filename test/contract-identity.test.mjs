import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'contract-identity.schema.json'), 'utf8'));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'contract-identity.golden.json'), 'utf8'));
const DOMAIN = 'beval.binding-json/1';

function canonical(value, seen = new Set()) {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('binding JSON numbers must be finite');
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length !== Object.keys(value).length) throw new TypeError('binding JSON arrays must not be sparse');
		return value.map((item) => canonical(item, seen));
	}
	if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new TypeError('binding JSON accepts only plain JSON objects');
	}
	if (seen.has(value)) throw new TypeError('binding JSON must not contain cycles');
	seen.add(value);
	const result = Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], seen)]));
	seen.delete(value);
	return result;
}

function bindingJson(value) {
	return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function bindingDigest(kind, value) {
	return crypto.createHash('sha256').update(`${DOMAIN}\n${kind}\n${bindingJson(value)}`).digest('hex');
}

test('contract identity golden refs validate against the versioned meta-schema', () => {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);
	const validate = ajv.compile(SCHEMA);
	for (const vector of GOLDEN.vectors) {
		assert.equal(validate(vector.value), true, `${vector.name}: ${ajv.errorsText(validate.errors)}`);
	}
});

test('binding-json golden digests pin key order, indentation, LF and domain framing', () => {
	for (const vector of GOLDEN.vectors) assert.equal(bindingDigest(vector.kind, vector.value), vector.digest, vector.name);
	assert.match(bindingJson(GOLDEN.vectors[0].value), /\n$/);
	assert.match(bindingJson(GOLDEN.vectors[0].value), /^\{\n  "contract_hash"/);
});

test('binding-json preserves Unicode bytes rather than normalizing them', () => {
	const vector = GOLDEN.unicode_non_normalization;
	assert.equal(bindingDigest(vector.kind, vector.precomposed.value), vector.precomposed.digest);
	assert.equal(bindingDigest(vector.kind, vector.decomposed.value), vector.decomposed.digest);
	assert.notEqual(vector.precomposed.digest, vector.decomposed.digest);
});

test('binding-json rejects non-JSON and non-finite values', () => {
	assert.throws(() => bindingJson({ value: undefined }), TypeError);
	assert.throws(() => bindingJson({ value: Number.NaN }), TypeError);
	assert.throws(() => bindingJson({ value: Number.POSITIVE_INFINITY }), TypeError);
	assert.throws(() => bindingJson(new Date()), TypeError);
	const sparse = []; sparse[1] = 'x';
	assert.throws(() => bindingJson(sparse), TypeError);
});
