// D-handles-providers (G4) follow-up: executed cross-language verification of
// handles/providers/java-spring/templates/HandleCodec.java.tmpl against handles/codec.mjs, the
// JS reference implementation. Mandatory, not skippable if a JDK (javac/java) is missing --
// mirrors test/handles-python-codec.test.mjs's own "mandatory, not skippable" precedent exactly,
// closing the twin gap that item's own header comment named as still open (see DECISIONS.md,
// D-handles-providers (G4)'s "Honest verification gap, left open on purpose"). Needs ZERO
// external Maven/Gradle dependencies -- HandleCodec.java.tmpl is pure java.* stdlib -- so unlike
// scripts/java-compile-smoke.mjs/java-ast-smoke.mjs (which need a Gradle build, kept out of
// `npm test` in their own dedicated CI jobs), a plain `javac`+`java` here is cheap enough to run
// on every `npm test` invocation, the same bar python3 already clears for the Python codec test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeHandle, decodeHandle, deriveHandleUid } from '../handles/codec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEC_TEMPLATE = path.join(__dirname, '..', 'handles', 'providers', 'java-spring', 'templates', 'HandleCodec.java.tmpl');

// Matches test/fixtures/java-compile's own DemoApplication.java package literal -- arbitrary but
// consistent with this repo's existing Java fixture corpus. HandleCodec.java.tmpl's own package
// declaration is `{{BASE_PACKAGE}}.global.handle`, so the rendered package is
// com.example.demo.global.handle.
const BASE_PACKAGE = 'com.example.demo';
const FULL_PACKAGE = `${BASE_PACKAGE}.global.handle`;
const DRIVER_CLASS = `${FULL_PACKAGE}.Driver`;

// A tiny ad-hoc {{KEY}} -> value substitution -- the exact mechanism
// handles/providers/java-spring/emit.mjs's own (unexported) render() helper uses, reimplemented
// here in 3 lines rather than exporting an internal helper just for a test.
function render(templatePath, vars) {
	let content = fs.readFileSync(templatePath, 'utf8');
	for (const [key, value] of Object.entries(vars)) content = content.replaceAll(`{{${key}}}`, String(value));
	return content;
}

// A small, test-only driver -- not a generated artifact, never shipped -- that lets this JS test
// exercise the rendered HandleCodec.java the same way a real resolver would call it. Java has no
// stdlib JSON library, so unlike handles-python-codec.test.mjs's JSON-array driver, this speaks a
// deliberately minimal line protocol: one op per stdin line (`OP|field|field|...`), one result per
// stdout line, in the same order. `OK|result...` on success, `ERR|message` on failure. An
// absent/null pointer is represented as an empty trailing field -- HandleCodec.java.tmpl's own
// encode()/decode()/deriveHandleUid() already treat null and "" identically throughout, so this
// loses no test fidelity. Both System.in and System.out are wrapped in explicit UTF-8 (not the
// platform default charset) so non-ASCII type names round-trip correctly. Protocol limitation,
// accepted deliberately: no field may contain a literal "|" -- true of every vector this file
// sends (base64url tokens, UUIDs, JSON Pointers, and the ASCII/Cyrillic type names below).
const DRIVER_SOURCE = `package ${FULL_PACKAGE};

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

public final class Driver {
	public static void main(String[] args) throws Exception {
		BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
		PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
		String line;
		while ((line = in.readLine()) != null) {
			if (line.isEmpty()) continue;
			out.println(handle(line));
		}
	}

	private static String handle(String line) {
		// limit=-1: without it, String.split() silently drops trailing empty fields (confirmed by
		// direct execution) -- exactly the "no pointer" field this protocol relies on for
		// kind=r/kind=o ops. Losing it would silently corrupt every no-pointer op.
		String[] parts = line.split("\\\\|", -1);
		String op = parts[0];
		try {
			switch (op) {
				case "ENCODE": {
					String kind = parts[1], type = parts[2];
					UUID uuid = UUID.fromString(parts[3]);
					String pointer = parts[4].isEmpty() ? null : parts[4];
					return "OK|" + HandleCodec.encode(kind, type, uuid, pointer);
				}
				case "DECODE": {
					HandleCodec.Decoded d = HandleCodec.decode(parts[1]);
					String pointer = d.pointer() == null ? "" : d.pointer();
					return "OK|" + d.kind() + "|" + d.type() + "|" + d.uuid() + "|" + pointer;
				}
				case "DERIVE": {
					String kind = parts[1], type = parts[2];
					UUID uuid = UUID.fromString(parts[3]);
					String pointer = parts[4].isEmpty() ? null : parts[4];
					return "OK|" + HandleCodec.deriveHandleUid(kind, type, uuid, pointer);
				}
				case "UUID5": {
					return "OK|" + HandleCodec.uuidv5(UUID.fromString(parts[1]), parts[2]);
				}
				case "RAWB64": {
					// D-security-10 confirmation (no HandleCodec involved at all): calls
					// java.util.Base64.getUrlDecoder().decode() directly, the same raw JDK API
					// HandleCodec.decode() wraps, mirroring the Python test's own direct
					// base64.urlsafe_b64decode confirmation.
					byte[] decoded = java.util.Base64.getUrlDecoder().decode(parts[1]);
					return "OK|" + new String(decoded, StandardCharsets.ISO_8859_1);
				}
				default:
					return "ERR|unknown op " + op;
			}
		} catch (Exception e) {
			String msg = String.valueOf(e.getMessage()).replace("\\n", " ").replace("\\r", " ");
			return "ERR|" + msg;
		}
	}
}
`;

let outDir;

before(() => {
	// javac/java are required, not optional -- this is exactly the gap this item exists to close.
	execFileSync('javac', ['-version']);
	execFileSync('java', ['-version']);

	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-codec-'));
	const packageDir = path.join(workDir, 'src', ...FULL_PACKAGE.split('.'));
	fs.mkdirSync(packageDir, { recursive: true });

	const handleCodecJava = render(CODEC_TEMPLATE, { BASE_PACKAGE });
	fs.writeFileSync(path.join(packageDir, 'HandleCodec.java'), handleCodecJava);
	fs.writeFileSync(path.join(packageDir, 'Driver.java'), DRIVER_SOURCE);

	outDir = path.join(workDir, 'out');
	fs.mkdirSync(outDir);
	execFileSync('javac', ['-d', outDir, path.join(packageDir, 'HandleCodec.java'), path.join(packageDir, 'Driver.java')]);
});

// Serializes {op, ...} descriptors to the OP|field|... line protocol, sends them all as one
// stdin payload (one warm `java` process handles the whole batch -- avoids per-op JVM startup
// cost), and parses each OK/ERR output line back into a {ok, result}/{ok, error} shape mirroring
// runPython()'s own return shape, so test bodies read almost identically to the Python file's.
function toLine(op) {
	switch (op.op) {
		case 'encode': return ['ENCODE', op.kind, op.type, op.uuid, op.pointer ?? ''].join('|');
		case 'decode': return ['DECODE', op.token].join('|');
		case 'derive': return ['DERIVE', op.kind, op.type, op.uuid, op.pointer ?? ''].join('|');
		case 'uuid5': return ['UUID5', op.namespace, op.name].join('|');
		case 'rawb64': return ['RAWB64', op.value].join('|');
		default: throw new Error(`unknown op "${op.op}"`);
	}
}

function runJava(ops) {
	const input = ops.map(toLine).join('\n') + '\n';
	const out = execFileSync('java', ['-cp', outDir, DRIVER_CLASS], { input, encoding: 'utf8' });
	const lines = out.split('\n').filter((l) => l.length > 0);
	return lines.map((line, i) => {
		const sep = line.indexOf('|');
		const status = line.slice(0, sep);
		const rest = line.slice(sep + 1);
		if (status === 'ERR') return { ok: false, error: rest };
		if (ops[i].op === 'decode') {
			const [kind, type, uuid, pointer] = rest.split('|');
			return { ok: true, result: { kind, type, uuid, pointer: pointer === '' ? null : pointer } };
		}
		return { ok: true, result: rest };
	});
}

test('HandleCodec.uuidv5 (Java) matches the same NAMESPACE_DNS + "example.com" reference vector handles/codec.mjs\'s hand-rolled uuidv5 is checked against', () => {
	const [result] = runJava([{ op: 'uuid5', namespace: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', name: 'example.com' }]);
	assert.equal(result.ok, true, result.error);
	assert.equal(result.result, 'cfbff0d1-9375-5685-968c-48ce8b15ae17');
});

test('encode in JS, decode in Java: byte-identical for kind=r, kind=f (with a pointer), and kind=o', () => {
	const vectors = [
		{ kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/policy/monthlyTokenLimit' },
		{ kind: 'o', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
	];
	const tokens = vectors.map((v) => encodeHandle(v));
	const results = runJava(tokens.map((token) => ({ op: 'decode', token })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.deepEqual(r.result, { kind: vectors[i].kind, type: vectors[i].type, uuid: vectors[i].uuid, pointer: vectors[i].pointer });
	});
});

test('encode in Java, decode in JS: byte-identical, including a JSON Pointer with ~0/~1 escapes and a non-ASCII type name', () => {
	const vectors = [
		{ kind: 'r', type: 'Организация', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/a~1b/c~0d' },
	];
	const results = runJava(vectors.map((v) => ({ op: 'encode', kind: v.kind, type: v.type, uuid: v.uuid, pointer: v.pointer })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.match(r.result, /^sbf1_[A-Za-z0-9_-]+$/);
		assert.deepEqual(decodeHandle(r.result), { ...vectors[i], pointer: vectors[i].pointer ?? null });
	});
});

test('padding-class parity: raw payload lengths that land on all 3 base64 padding remainders round-trip byte-identical', () => {
	const vectors = ['a', 'ab', 'abc'].map((type) => ({ kind: 'r', type, uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null }));
	const tokens = vectors.map((v) => encodeHandle(v));
	const results = runJava(tokens.map((token) => ({ op: 'decode', token })));
	results.forEach((r, i) => {
		assert.equal(r.ok, true, r.error);
		assert.deepEqual(r.result, { kind: vectors[i].kind, type: vectors[i].type, uuid: vectors[i].uuid, pointer: null });
	});
});

test('HandleCodec.deriveHandleUid (Java) matches handles/codec.mjs\'s deriveHandleUid exactly for kind=r/f/o', () => {
	const base = { type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97' };
	const cases = [
		{ kind: 'r', ...base, pointer: null },
		{ kind: 'f', ...base, pointer: '/policy/monthlyTokenLimit' },
		{ kind: 'o', ...base, pointer: null },
	];
	const results = runJava(cases.map((c) => ({ op: 'derive', kind: c.kind, type: c.type, uuid: c.uuid, pointer: c.pointer })));
	cases.forEach((c, i) => {
		assert.equal(results[i].ok, true, results[i].error);
		assert.equal(results[i].result, deriveHandleUid(c));
	});
});

test('negative parity: Java rejects the exact same malformed input JS rejects (charset, missing prefix, over-length, kind/pointer mismatch)', () => {
	const [charset, prefix, tooLong] = runJava([
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

	const [noPointer, strayPointer] = runJava([
		{ op: 'encode', kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: null },
		{ op: 'encode', kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/name' },
	]);
	assert.equal(noPointer.ok, false);
	assert.match(noPointer.error, /require.*Pointer/i);
	assert.equal(strayPointer.ok, false);
	assert.match(strayPointer.error, /must not carry a JSON Pointer/);
});

// D-security-10 parity, confirmed directly against this Java runtime (not assumed): Java's own
// Base64.getUrlDecoder().decode() really does throw on invalid-charset input -- the mirror image
// of handles-python-codec.test.mjs's own confirmation that Python's base64.urlsafe_b64decode
// does NOT throw (silently discards junk instead). Together the two tests prove the asymmetry
// handles/codec.mjs's own D-security-10 comment (and HandleCodec.java.tmpl's implicit behavior)
// claims, rather than assuming either half.
test('Java\'s Base64.getUrlDecoder().decode() really does throw on invalid-charset input (confirms why Node\'s pre-D-security-10 silent-ignore behavior was a real JS/Java divergence, not a false alarm)', () => {
	const [result] = runJava([{ op: 'rawb64', value: 'QU!JD' }]);
	assert.equal(result.ok, false);
	assert.match(result.error, /Illegal base64 character/i);
});
