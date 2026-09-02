// D-typescript-express-provider (G5): executed cross-language verification of handles/providers/
// typescript-express/templates/codec.ts.tmpl against handles/codec.mjs, the JS reference
// implementation. Mandatory, not skippable -- unlike the Java/Python codec tests, this needs no
// external toolchain at all (Node is already this whole CLI's own runtime), so it runs inside
// plain `npm test` with no new CI job. `--experimental-strip-types` is passed explicitly even
// though Node 26 (this machine) doesn't require it -- Node 22.x (this repo's CI floor) does; see
// D-typescript-express-provider in DECISIONS.md for the confirmed per-version behavior.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeHandle, decodeHandle, deriveHandleUid, resolveJsonPointer } from '../handles/codec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEC_TEMPLATE = path.join(__dirname, '..', 'handles', 'providers', 'typescript-express', 'templates', 'codec.ts.tmpl');

// A small, test-only driver -- not a generated artifact, never shipped -- that lets this JS test
// exercise the rendered codec.ts the same way a real resolver would import it. Reads a JSON array
// of {op, ...args} from stdin, prints a JSON array of {ok, result} | {ok, missing} | {ok: false,
// error} to stdout. TypeScript source, but zero non-erasable syntax (only type annotations and an
// `as` cast, both fully erasable) -- runs directly via `node --experimental-strip-types`.
const DRIVER_SOURCE = `
import { readFileSync } from 'node:fs';
import { encodeHandle, decodeHandle, deriveHandleUid, uuidv5, resolveJsonPointer } from './codec.ts';

const ops: any[] = JSON.parse(readFileSync(0, 'utf8'));
const results: any[] = [];
for (const op of ops) {
  try {
    if (op.op === 'encode') {
      results.push({ ok: true, result: encodeHandle(op.kind, op.type, op.uuid, op.pointer ?? null) });
    } else if (op.op === 'decode') {
      results.push({ ok: true, result: decodeHandle(op.token) });
    } else if (op.op === 'derive') {
      results.push({ ok: true, result: deriveHandleUid(op.kind, op.type, op.uuid, op.pointer ?? null) });
    } else if (op.op === 'uuidv5') {
      results.push({ ok: true, result: uuidv5(op.namespace, op.name) });
    } else if (op.op === 'pointer') {
      const target = resolveJsonPointer(op.obj, op.pointer ?? null);
      if (target === undefined) results.push({ ok: true, missing: true });
      else results.push({ ok: true, result: target });
    } else {
      results.push({ ok: false, error: \`unknown op \${op.op}\` });
    }
  } catch (e) {
    results.push({ ok: false, error: (e as Error).message });
  }
}
console.log(JSON.stringify(results));
`;

let workDir;
let codecTsPath;
let driverPath;

before(() => {
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-codec-'));
	codecTsPath = path.join(workDir, 'codec.ts');
	fs.copyFileSync(CODEC_TEMPLATE, codecTsPath); // codec.ts.tmpl has zero {{VAR}} substitutions
	driverPath = path.join(workDir, 'driver.ts');
	fs.writeFileSync(driverPath, DRIVER_SOURCE);
});

function runTypeScript(ops) {
	const out = execFileSync('node', ['--experimental-strip-types', driverPath], { input: JSON.stringify(ops), encoding: 'utf8' });
	return JSON.parse(out);
}

test('uuidv5 (hand-rolled, node:crypto sha1) matches the same NAMESPACE_DNS + "example.com" reference vector handles/codec.mjs\'s own uuidv5 is checked against', () => {
	const [result] = runTypeScript([{ op: 'uuidv5', namespace: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', name: 'example.com' }]);
	assert.equal(result.ok, true);
	assert.equal(result.result, 'cfbff0d1-9375-5685-968c-48ce8b15ae17');
});

test('encode in JS, decode in TypeScript: byte-identical for kind=r, kind=f (with a pointer), and kind=o', () => {
	const vectors = [
		{ kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/policy/monthlyTokenLimit' },
		{ kind: 'o', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
	];
	const tokens = vectors.map((v) => encodeHandle(v));
	const results = runTypeScript(tokens.map((token) => ({ op: 'decode', token })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.deepEqual(r.result, { kind: vectors[i].kind, type: vectors[i].type, uuid: vectors[i].uuid, pointer: vectors[i].pointer });
	});
});

test('encode in TypeScript, decode in JS: byte-identical, including a JSON Pointer with ~0/~1 escapes and a non-ASCII type name', () => {
	const vectors = [
		{ kind: 'r', type: 'Организация', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/a~1b/c~0d' },
	];
	const results = runTypeScript(vectors.map((v) => ({ op: 'encode', kind: v.kind, type: v.type, uuid: v.uuid, pointer: v.pointer })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.match(r.result, /^sbf1_[A-Za-z0-9_-]+$/);
		const decoded = decodeHandle(r.result);
		assert.deepEqual(decoded, { ...vectors[i], pointer: vectors[i].pointer ?? null });
	});
});

test('padding-class parity: raw payload lengths that land on all 3 base64 padding remainders round-trip byte-identical', () => {
	const vectors = ['a', 'ab', 'abc'].map((type) => ({ kind: 'r', type, uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null }));
	const tokens = vectors.map((v) => encodeHandle(v));
	const results = runTypeScript(tokens.map((token) => ({ op: 'decode', token })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.deepEqual(r.result, { kind: vectors[i].kind, type: vectors[i].type, uuid: vectors[i].uuid, pointer: null });
	});
});

test('deriveHandleUid (TypeScript) matches handles/codec.mjs\'s deriveHandleUid exactly for kind=r/f/o', () => {
	const base = { type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97' };
	const cases = [
		{ kind: 'r', ...base, pointer: null },
		{ kind: 'f', ...base, pointer: '/policy/monthlyTokenLimit' },
		{ kind: 'o', ...base, pointer: null },
	];
	const results = runTypeScript(cases.map((c) => ({ op: 'derive', kind: c.kind, type: c.type, uuid: c.uuid, pointer: c.pointer })));
	cases.forEach((c, i) => {
		assert.equal(results[i].ok, true, results[i].error);
		assert.equal(results[i].result, deriveHandleUid(c));
	});
});

// O3 (D-handle-uid-type-binding): kind=r used to return uuid VERBATIM (no type binding at all) --
// this is the regression guard that the fix actually took, on both the JS reference and the real
// rendered TypeScript file, not just the parity check above (which would pass even if BOTH sides
// had regressed back to the old verbatim behavior together). Parity-only fix for this provider --
// it has no HandleRegistry table (see D-typescript-express-provider), so there is no live
// collision to reproduce here the way the Java/Python tests do.
test('kind=r no longer returns the resource uuid verbatim, in JS or TypeScript', () => {
	const c = { kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null };
	const jsResult = deriveHandleUid(c);
	assert.notEqual(jsResult, c.uuid, 'JS deriveHandleUid must no longer be the identity function for kind=r');
	const [tsResult] = runTypeScript([{ op: 'derive', ...c }]);
	assert.equal(tsResult.ok, true, tsResult.error);
	assert.notEqual(tsResult.result, c.uuid, 'TypeScript deriveHandleUid must no longer be the identity function for kind=r');
	assert.equal(tsResult.result, jsResult);
});

// D-typescript-express-provider: resolveJsonPointer needed NO `_MISSING`-style sentinel here,
// unlike the Python port -- TypeScript/JavaScript already distinguishes `undefined` (absent) from
// a genuine `null`, so this is a direct, unmodified port of the JS reference's own logic. Confirmed
// live, not assumed.
// D-handle-identity-contract-freeze (Phase 3, item 1): a literal golden-vector pin against the
// REAL rendered TypeScript file, not just the JS reference -- see handles-codec.test.mjs's own
// copy of this test for why a relative cross-language parity check alone can't catch a shared
// drift.
test('golden vectors: encodeHandle/deriveHandleUid (TypeScript) output is pinned for kind=r, kind=f, and kind=o (sbf1_ contract freeze)', () => {
	const type = 'Organization';
	const uuid = 'e957347e-3794-4c71-92a8-cec75dec1c97';
	const pointer = '/policy/monthlyTokenLimit';
	const [rEncode, rDerive, fEncode, fDerive, oEncode, oDerive] = runTypeScript([
		{ op: 'encode', kind: 'r', type, uuid, pointer: null },
		{ op: 'derive', kind: 'r', type, uuid, pointer: null },
		{ op: 'encode', kind: 'f', type, uuid, pointer },
		{ op: 'derive', kind: 'f', type, uuid, pointer },
		{ op: 'encode', kind: 'o', type, uuid, pointer: null },
		{ op: 'derive', kind: 'o', type, uuid, pointer: null },
	]);
	assert.equal(rEncode.result, 'sbf1_cjpPcmdhbml6YXRpb246ZTk1NzM0N2UtMzc5NC00YzcxLTkyYTgtY2VjNzVkZWMxYzk3');
	assert.equal(rDerive.result, 'b780c5c9-fc69-5cdd-ae9f-85593a41e700');
	assert.equal(fEncode.result, 'sbf1_ZjpPcmdhbml6YXRpb246ZTk1NzM0N2UtMzc5NC00YzcxLTkyYTgtY2VjNzVkZWMxYzk3Oi9wb2xpY3kvbW9udGhseVRva2VuTGltaXQ');
	assert.equal(fDerive.result, '5c7bfad5-0ae0-548e-8aeb-afd00bc76bc2');
	assert.equal(oEncode.result, 'sbf1_bzpPcmdhbml6YXRpb246ZTk1NzM0N2UtMzc5NC00YzcxLTkyYTgtY2VjNzVkZWMxYzk3');
	assert.equal(oDerive.result, '00b01a52-291c-5664-879c-c0ad798cd2e1');
});

// D-handle-identity-contract-freeze (Phase 3, item 2): the dual-scheme dispatch hook fails closed
// on a scheme it doesn't recognize, in the real rendered TypeScript file -- proves the hook
// actually gates on the registered-scheme table rather than falling through to the sbf1 decoder.
test('decodeHandle rejects a well-formed but unregistered scheme (e.g. a future sbf2_ token) instead of misdecoding it as sbf1', () => {
	const notYetRegistered = `sbf2_${Buffer.from('r:Organization:e957347e-3794-4c71-92a8-cec75dec1c97', 'utf8').toString('base64url')}`;
	const [result] = runTypeScript([{ op: 'decode', token: notYetRegistered }]);
	assert.equal(result.ok, false);
	assert.match(result.error, /not an sbf1 handle/);
});

test('resolveJsonPointer matches handles/codec.mjs\'s resolveJsonPointer exactly, including the null-vs-missing distinction', () => {
	const obj = { a: { b: [1, 2, { c: null }] }, 'a/b': 'slash-key', 'c~d': 'tilde-key' };
	const vectors = [
		{ pointer: null },
		{ pointer: '' },
		{ pointer: '/a/b/0' },
		{ pointer: '/a/b/2/c' }, // resolves to a genuine JSON null -- must NOT be reported missing
		{ pointer: '/a/b/99' }, // out of range -- missing
		{ pointer: '/nope' }, // absent key -- missing
		{ pointer: '/a/x/y' }, // walks through a non-container -- missing
		{ pointer: '/a~1b' }, // ~1 -> "/" escape
		{ pointer: '/c~0d' }, // ~0 -> "~" escape
	];
	const results = runTypeScript(vectors.map((v) => ({ op: 'pointer', obj, pointer: v.pointer })));
	vectors.forEach((v, i) => {
		const jsResult = resolveJsonPointer(obj, v.pointer);
		const tsResult = results[i];
		assert.equal(tsResult.ok, true, tsResult.error);
		if (jsResult === undefined) {
			assert.equal(tsResult.missing, true, `pointer "${v.pointer}": JS says missing, TypeScript did not`);
		} else {
			assert.equal(tsResult.missing, undefined, `pointer "${v.pointer}": TypeScript says missing, JS did not`);
			assert.deepEqual(tsResult.result, jsResult);
		}
	});
});

test('resolveJsonPointer: a non-"/"-prefixed pointer raises the same shaped error in both languages', () => {
	const [result] = runTypeScript([{ op: 'pointer', obj: { a: 1 }, pointer: 'no-leading-slash' }]);
	assert.equal(result.ok, false);
	assert.match(result.error, /must start with "\/"/);
	assert.throws(() => resolveJsonPointer({ a: 1 }, 'no-leading-slash'), /must start with "\/"/);
});

test('negative parity: TypeScript rejects the exact same malformed input JS rejects (charset, missing prefix, over-length, kind/pointer mismatch)', () => {
	const [charset, prefix, tooLong] = runTypeScript([
		{ op: 'decode', token: 'sbf1_not!valid++base64==' },
		{ op: 'decode', token: 'not-a-handle' },
		{ op: 'decode', token: `sbf1_${'A'.repeat(3000)}` },
	]);
	assert.equal(charset.ok, false);
	assert.match(charset.error, /not valid base64url/);
	assert.equal(prefix.ok, false);
	assert.match(prefix.error, /sbf1/);
	assert.equal(tooLong.ok, false);
	assert.match(tooLong.error, /exceeds the maximum length/);

	const [noPointer, strayPointer] = runTypeScript([
		{ op: 'encode', kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ op: 'encode', kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/name' },
	]);
	assert.equal(noPointer.ok, false);
	assert.match(noPointer.error, /require.*Pointer/i);
	assert.equal(strayPointer.ok, false);
	assert.match(strayPointer.error, /must not carry a JSON Pointer/);
});

// D-security-10 parity: this is the ONE case where TypeScript needed no independent re-confirmation
// -- codec.ts.tmpl runs on the exact same Node runtime this whole CLI already runs on, so
// Buffer.from(str, 'base64')'s silent-discard behavior is already established, not a new fact to
// verify per-language the way it was for Python's separate base64 implementation.
test('the explicit BASE64URL_CHARSET_RE guard in codec.ts.tmpl is load-bearing: without it, Buffer.from would silently discard invalid characters instead of raising', () => {
	const out = execFileSync('node', ['-e', "process.stdout.write(Buffer.from('QU!JD', 'base64').toString('latin1'))"], { encoding: 'utf8' });
	assert.equal(out, 'ABC');
});
