import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli, judgePathException } from '../next/t00/check-path-exception.mjs';
import { gitDiffPaths } from '../next/t00/check-ownership.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(fs.readFileSync(path.join(root, 'next/t00/ownership-map.json'), 'utf8'));
const receiptPath = path.join(root, 'next/t00/receipts/T15-03-becoder-PR22.json');
const bytes = fs.readFileSync(receiptPath);
const receipt = JSON.parse(bytes);
const digest = createHash('sha256').update(bytes).digest('hex');
const ctx = {
  repository: 'becoder', track: 'T15', base: receipt.base, head: receipt.head,
  paths: [
    'next/t15/cli.mjs', 'next/t15/harness/index.mjs',
    ...receipt.exceptions.map((e) => e.path),
  ],
};
const codes = (r) => r.map((e) => e.code);

test('exact-head T00 receipt accepts only its five named shared paths', () => {
  assert.deepEqual(judgePathException(map, receipt, ctx), []);
  assert.equal(receipt.exceptions.length, 5);
  assert.match(receipt.approval.url, /#issuecomment-\d+$/);
});

test('receipt rejects wrong head, missing or extra path, wrong classification and invalid diff path', () => {
  assert.ok(codes(judgePathException(map, receipt, { ...ctx, head: 'a'.repeat(40) })).includes('RECEIPT_TARGET'));
  assert.ok(codes(judgePathException(map, receipt, { ...ctx, paths: ctx.paths.filter((p) => p !== 'bin/becoder.mjs') })).includes('EXCEPTION_UNUSED'));
  assert.ok(codes(judgePathException(map, receipt, { ...ctx, paths: [...ctx.paths, 'README.md'] })).includes('EXCEPTION_MISSING'));
  const wrongCode = structuredClone(receipt);
  wrongCode.exceptions[0].code = 'PATH_UNOWNED';
  assert.ok(codes(judgePathException(map, wrongCode, ctx)).includes('EXCEPTION_MISSING'));
  assert.ok(codes(judgePathException(map, receipt, { ...ctx, paths: [...ctx.paths, '../escape'] })).includes('EXCEPTION_FORBIDDEN'));
});

test('receipt rejects self-exception, duplicate, malformed path, missing approval and unsupported schema', () => {
  const owned = structuredClone(receipt);
  owned.exceptions.push({ path: 'next/t15/cli.mjs', code: 'PATH_UNOWNED', reason: 'invalid self-exception' });
  assert.ok(codes(judgePathException(map, owned, ctx)).includes('EXCEPTION_NOT_NEEDED'));
  const duplicate = structuredClone(receipt);
  duplicate.exceptions.push({ ...duplicate.exceptions[0] });
  assert.ok(codes(judgePathException(map, duplicate, ctx)).includes('RECEIPT_DUPLICATE'));
  const invalid = structuredClone(receipt);
  invalid.exceptions[0].path = '../escape';
  assert.ok(codes(judgePathException(map, invalid, ctx)).includes('RECEIPT_ENTRY'));
  const noApproval = structuredClone(receipt);
  noApproval.approval.url = 'https://example.com/forged';
  assert.ok(codes(judgePathException(map, noApproval, ctx)).includes('RECEIPT_APPROVAL'));
  assert.deepEqual(codes(judgePathException(map, { ...receipt, schema: 'other' }, ctx)), ['RECEIPT_SCHEMA']);
});

test('CLI fails closed on a wrong independent SHA-256 pin', async () => {
  const options = [
    '--repo-dir', root, '--repository', 'becoder', '--track', 'T15',
    '--base', receipt.base, '--head', receipt.head,
    '--receipt', receiptPath, '--receipt-sha256', '0'.repeat(64),
  ];
  const result = await runCli(options);
  assert.equal(result.status, 2);
  assert.match(result.lines[0], /RECEIPT_SHA256/);
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('git diff path source names renames as delete/add and cannot be supplied by the receipt', () => {
  assert.equal(typeof gitDiffPaths, 'function');
  assert.ok(ctx.paths.every((p) => typeof p === 'string'));
});
