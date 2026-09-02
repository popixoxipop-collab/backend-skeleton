// D-handles-providers (G4): executed cross-language verification of handles/providers/python-
// fastapi/templates/codec.py.tmpl against handles/codec.mjs, the JS reference implementation.
// Mandatory, not skippable if python3 is missing. The equivalent JS<->Java gap (this file's
// Python-side twin) is closed the same way in test/handles-java-codec.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeHandle, decodeHandle, deriveHandleUid, resolveJsonPointer } from '../handles/codec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEC_TEMPLATE = path.join(__dirname, '..', 'handles', 'providers', 'python-fastapi', 'templates', 'codec.py.tmpl');

// A small, test-only driver -- not a generated artifact, never shipped -- that lets this JS test
// exercise the rendered codec.py the same way a real resolver would import it. Takes a JSON array
// of {op, ...args} on stdin, prints a JSON array of {ok, result} | {ok, error} to stdout.
const DRIVER_SOURCE = `
import sys, json, importlib.util, uuid

spec = importlib.util.spec_from_file_location("codec", sys.argv[1])
codec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codec)

ops = json.loads(sys.stdin.read())
results = []
for op in ops:
    try:
        kind = op.get("op")
        if kind == "encode":
            token = codec.encode_handle(op["kind"], op["type"], op["uuid"], op.get("pointer"))
            results.append({"ok": True, "result": token})
        elif kind == "decode":
            d = codec.decode_handle(op["token"])
            results.append({"ok": True, "result": {"kind": d.kind, "type": d.type, "uuid": d.uuid, "pointer": d.pointer}})
        elif kind == "derive":
            uid = codec.derive_handle_uid(op["kind"], op["type"], op["uuid"], op.get("pointer"))
            results.append({"ok": True, "result": uid})
        elif kind == "uuid5":
            uid = str(uuid.uuid5(uuid.UUID(op["namespace"]), op["name"]))
            results.append({"ok": True, "result": uid})
        elif kind == "pointer":
            target = codec.resolve_json_pointer(op["obj"], op.get("pointer"))
            if target is codec.MISSING:
                results.append({"ok": True, "missing": True})
            else:
                results.append({"ok": True, "result": target})
        else:
            results.append({"ok": False, "error": f"unknown op {kind}"})
    except Exception as e:
        results.append({"ok": False, "error": str(e)})
print(json.dumps(results))
`;

let workDir;
let codecPyPath;
let driverPath;

before(() => {
	// python3 is required, not optional -- this is exactly the gap this item exists to close.
	execFileSync('python3', ['--version']);

	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-codec-'));
	codecPyPath = path.join(workDir, 'codec.py');
	fs.copyFileSync(CODEC_TEMPLATE, codecPyPath); // codec.py.tmpl has zero {{VAR}} substitutions
	driverPath = path.join(workDir, 'driver.py');
	fs.writeFileSync(driverPath, DRIVER_SOURCE);
});

function runPython(ops) {
	const out = execFileSync('python3', [driverPath, codecPyPath], { input: JSON.stringify(ops), encoding: 'utf8' });
	return JSON.parse(out);
}

test('uuid.uuid5 (Python stdlib) matches the same NAMESPACE_DNS + "example.com" reference vector handles/codec.mjs\'s hand-rolled uuidv5 is checked against', () => {
	const [result] = runPython([{ op: 'uuid5', namespace: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', name: 'example.com' }]);
	assert.equal(result.ok, true);
	assert.equal(result.result, 'cfbff0d1-9375-5685-968c-48ce8b15ae17');
});

test('encode in JS, decode in Python: byte-identical for kind=r, kind=f (with a pointer), and kind=o', () => {
	const vectors = [
		{ kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/policy/monthlyTokenLimit' },
		{ kind: 'o', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
	];
	const tokens = vectors.map((v) => encodeHandle(v));
	const results = runPython(tokens.map((token) => ({ op: 'decode', token })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.deepEqual(r.result, { kind: vectors[i].kind, type: vectors[i].type, uuid: vectors[i].uuid, pointer: vectors[i].pointer });
	});
});

test('encode in Python, decode in JS: byte-identical, including a JSON Pointer with ~0/~1 escapes and a non-ASCII type name', () => {
	const vectors = [
		{ kind: 'r', type: 'Организация', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/a~1b/c~0d' },
	];
	const results = runPython(vectors.map((v) => ({ op: 'encode', kind: v.kind, type: v.type, uuid: v.uuid, pointer: v.pointer })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.match(r.result, /^sbf1_[A-Za-z0-9_-]+$/);
		const decoded = decodeHandle(r.result);
		assert.deepEqual(decoded, { ...vectors[i], pointer: vectors[i].pointer ?? null });
	});
});

test('padding-class parity: raw payload lengths that land on all 3 base64 padding remainders round-trip byte-identical', () => {
	// The `/`-joined uuid+type text length (before base64) varies with type-name length, which
	// changes how much '=' padding base64 needs (0, 1, or 2 chars) -- exercise all three.
	const vectors = ['a', 'ab', 'abc'].map((type) => ({ kind: 'r', type, uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null }));
	const tokens = vectors.map((v) => encodeHandle(v));
	const results = runPython(tokens.map((token) => ({ op: 'decode', token })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.deepEqual(r.result, { kind: vectors[i].kind, type: vectors[i].type, uuid: vectors[i].uuid, pointer: null });
	});
});

test('derive_handle_uid matches handles/codec.mjs\'s deriveHandleUid exactly for kind=r/f/o', () => {
	const base = { type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97' };
	const cases = [
		{ kind: 'r', ...base, pointer: null },
		{ kind: 'f', ...base, pointer: '/policy/monthlyTokenLimit' },
		{ kind: 'o', ...base, pointer: null },
	];
	const results = runPython(cases.map((c) => ({ op: 'derive', kind: c.kind, type: c.type, uuid: c.uuid, pointer: c.pointer })));
	cases.forEach((c, i) => {
		assert.equal(results[i].ok, true, results[i].error);
		assert.equal(results[i].result, deriveHandleUid(c));
	});
});

// O3 (D-handle-uid-type-binding): kind=r used to return resource_uuid VERBATIM (no type binding
// at all) -- this is the regression guard that the fix actually took, on both the JS reference
// and the real rendered Python file, not just the parity check above (which would pass even if
// BOTH sides had regressed back to the old verbatim behavior together).
test('kind=r no longer returns the resource uuid verbatim, in JS or Python', () => {
	const c = { kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null };
	const jsResult = deriveHandleUid(c);
	assert.notEqual(jsResult, c.uuid, 'JS deriveHandleUid must no longer be the identity function for kind=r');
	const [pyResult] = runPython([{ op: 'derive', ...c }]);
	assert.equal(pyResult.ok, true, pyResult.error);
	assert.notEqual(pyResult.result, c.uuid, 'Python derive_handle_uid must no longer be the identity function for kind=r');
	assert.equal(pyResult.result, jsResult);
});

// O3 (D-handle-uid-type-binding): the real bug this item fixes -- reproduced live against the
// REAL rendered Python file, not just asserted. Before the fix, two different resource TYPES
// sharing the same resourceUid derived the SAME handle_uid (the sbf_handle table's own primary
// key), silently colliding on one registry row. This test is written so it would FAIL against the
// pre-fix formula (kind=r -> resource_uuid verbatim, type-independent) and PASSES only because
// type now participates in the hash.
test('collision fix: two different resource types sharing the same UUID derive DIFFERENT kind=r handle_uids (Python)', () => {
	const sharedUuid = 'e957347e-3794-4c71-92a8-cec75dec1c97';
	const [widget, organization] = runPython([
		{ op: 'derive', kind: 'r', type: 'Widget', uuid: sharedUuid, pointer: null },
		{ op: 'derive', kind: 'r', type: 'Organization', uuid: sharedUuid, pointer: null },
	]);
	assert.equal(widget.ok, true, widget.error);
	assert.equal(organization.ok, true, organization.error);
	assert.notEqual(widget.result, organization.result, 'two different resource types sharing a UUID must never derive the same handle_uid (registry primary key collision)');
	assert.equal(widget.result, deriveHandleUid({ kind: 'r', type: 'Widget', uuid: sharedUuid, pointer: null }));
	assert.equal(organization.result, deriveHandleUid({ kind: 'r', type: 'Organization', uuid: sharedUuid, pointer: null }));
});

// G4 follow-up (D-handles-providers): resolve_json_pointer parity, including the exact case a
// literal JS port would have gotten wrong -- a present-but-null field must resolve to `null`
// (200), not be conflated with "path doesn't exist" (404). See resolve_json_pointer's own
// docstring in codec.py.tmpl for why a naive `None`-as-missing sentinel would regress this.
// D-handle-identity-contract-freeze (Phase 3, item 1): a literal golden-vector pin against the
// REAL rendered Python module, not just the JS reference -- see handles-codec.test.mjs's own copy
// of this test for why a relative cross-language parity check alone can't catch a shared drift.
test('golden vectors: encode_handle/derive_handle_uid (Python) output is pinned for kind=r, kind=f, and kind=o (sbf1_ contract freeze)', () => {
	const type_ = 'Organization';
	const uuid = 'e957347e-3794-4c71-92a8-cec75dec1c97';
	const pointer = '/policy/monthlyTokenLimit';
	const [rEncode, rDerive, fEncode, fDerive, oEncode, oDerive] = runPython([
		{ op: 'encode', kind: 'r', type: type_, uuid, pointer: null },
		{ op: 'derive', kind: 'r', type: type_, uuid, pointer: null },
		{ op: 'encode', kind: 'f', type: type_, uuid, pointer },
		{ op: 'derive', kind: 'f', type: type_, uuid, pointer },
		{ op: 'encode', kind: 'o', type: type_, uuid, pointer: null },
		{ op: 'derive', kind: 'o', type: type_, uuid, pointer: null },
	]);
	assert.equal(rEncode.result, 'sbf1_cjpPcmdhbml6YXRpb246ZTk1NzM0N2UtMzc5NC00YzcxLTkyYTgtY2VjNzVkZWMxYzk3');
	assert.equal(rDerive.result, 'b780c5c9-fc69-5cdd-ae9f-85593a41e700');
	assert.equal(fEncode.result, 'sbf1_ZjpPcmdhbml6YXRpb246ZTk1NzM0N2UtMzc5NC00YzcxLTkyYTgtY2VjNzVkZWMxYzk3Oi9wb2xpY3kvbW9udGhseVRva2VuTGltaXQ');
	assert.equal(fDerive.result, '5c7bfad5-0ae0-548e-8aeb-afd00bc76bc2');
	assert.equal(oEncode.result, 'sbf1_bzpPcmdhbml6YXRpb246ZTk1NzM0N2UtMzc5NC00YzcxLTkyYTgtY2VjNzVkZWMxYzk3');
	assert.equal(oDerive.result, '00b01a52-291c-5664-879c-c0ad798cd2e1');
});

// D-handle-identity-contract-freeze (Phase 3, item 2): the dual-scheme dispatch hook fails closed
// on a scheme it doesn't recognize, in the real rendered Python module -- proves the hook actually
// gates on the registered-scheme table rather than falling through to the sbf1 decoder.
test('decode_handle rejects a well-formed but unregistered scheme (e.g. a future sbf2_ token) instead of misdecoding it as sbf1', () => {
	const notYetRegistered = `sbf2_${Buffer.from('r:Organization:e957347e-3794-4c71-92a8-cec75dec1c97', 'utf8').toString('base64url')}`;
	const [result] = runPython([{ op: 'decode', token: notYetRegistered }]);
	assert.equal(result.ok, false);
	assert.match(result.error, /not an sbf1 handle/);
});

test('resolve_json_pointer matches handles/codec.mjs\'s resolveJsonPointer exactly, including the null-vs-missing distinction', () => {
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
	const results = runPython(vectors.map((v) => ({ op: 'pointer', obj, pointer: v.pointer })));
	vectors.forEach((v, i) => {
		const jsResult = resolveJsonPointer(obj, v.pointer);
		const pyResult = results[i];
		assert.equal(pyResult.ok, true, pyResult.error);
		if (jsResult === undefined) {
			assert.equal(pyResult.missing, true, `pointer "${v.pointer}": JS says missing, Python did not`);
		} else {
			assert.equal(pyResult.missing, undefined, `pointer "${v.pointer}": Python says missing, JS did not`);
			assert.deepEqual(pyResult.result, jsResult);
		}
	});
});

test('resolve_json_pointer: a non-"/"-prefixed pointer raises the same shaped error in both languages', () => {
	const [result] = runPython([{ op: 'pointer', obj: { a: 1 }, pointer: 'no-leading-slash' }]);
	assert.equal(result.ok, false);
	assert.match(result.error, /must start with "\/"/);
	assert.throws(() => resolveJsonPointer({ a: 1 }, 'no-leading-slash'), /must start with "\/"/);
});

test('negative parity: Python rejects the exact same malformed input JS rejects (charset, missing prefix, over-length, kind/pointer mismatch)', () => {
	const [charset, prefix, tooLong] = runPython([
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

	const [noPointer, strayPointer] = runPython([
		{ op: 'encode', kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ op: 'encode', kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/name' },
	]);
	assert.equal(noPointer.ok, false);
	assert.match(noPointer.error, /require.*Pointer/i);
	assert.equal(strayPointer.ok, false);
	assert.match(strayPointer.error, /must not carry a JSON Pointer/);
});

// D-security-10 parity, confirmed directly against this Python runtime (not assumed): Python's
// own `base64.urlsafe_b64decode` has the identical "silently discards junk characters" defect
// Node's `Buffer.from(str, 'base64')` had before D-security-10 fixed it for JS -- the explicit
// charset check in codec.py.tmpl is what closes this for Python, not the padding fix alone.
test('Python\'s base64.urlsafe_b64decode really does silently discard invalid characters (confirms why the explicit charset check in codec.py.tmpl is load-bearing, not redundant)', () => {
	const out = execFileSync('python3', ['-c', `
import base64
print(base64.urlsafe_b64decode("QU!JD").decode("latin1"))
`], { encoding: 'utf8' }).trim();
	// "QU!JD" with the invalid "!" silently stripped decodes exactly as "QUJD" would (-> "ABC"),
	// instead of raising -- confirmed by direct execution, the exact defect D-security-10 already
	// fixed on the JS side (Node's `Buffer.from(str, 'base64')` had the same behavior).
	assert.equal(out, 'ABC');
});
