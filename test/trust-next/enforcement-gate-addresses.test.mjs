import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { classifyAddress } from '../../lib/trust-next/enforcement-gate.mjs';

// The address classes of the enforcement gate checked against the IANA registries themselves, not against a second copy of the
// gate's own table. The three registry files are committed under iana-registries/ and pinned by hash; the expectations below are
// computed from their rows with BigInt arithmetic, and every row boundary plus a sweep over the address space is compared with
// classifyAddress(). The files were downloaded read-only on 2026-10-09:
//   https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv
//   https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
//   https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
// `downloaded_sha256` is the hash of the file as downloaded (CRLF line endings). `sha256` is the hash with carriage returns removed
// (`tr -d '\r' < file | shasum -a 256`), which is what is checked, so a checkout that converts line endings still verifies.

const REGISTRY_DIR = new URL('./iana-registries/', import.meta.url);
const REGISTRIES = {
  unicast: {
    file: 'ipv6-unicast-address-assignments.csv', rows: 51,
    downloaded_sha256: 'ebff425bb1acbbea29c4f28146930873faddd5ee57260e95b57ed9e04ea21dd8',
    sha256: 'fc4447c17919feabe21bdaf17b4a929cef117ccb25814967f0c001dc0c981d49',
  },
  special6: {
    file: 'iana-ipv6-special-registry-1.csv', rows: 25,
    downloaded_sha256: '775feea0621dec8735a44fbf30f762e721e8f0a1b3ab7eb341961a88cfce2139',
    sha256: '8b0e181a4ef0c71fcb25403c40702f2050c2f6dc198156b6ec1a5fb746c9a73e',
  },
  special4: {
    file: 'iana-ipv4-special-registry-1.csv', rows: 25,
    downloaded_sha256: 'e3e39e76d00b1677335db8e9a805c7b9480ea2f4dc9e33f0b93cd3a905128d73',
    sha256: 'e4a1c06ecf8e934ed5ae30977a1477a78957da1a5fb602fc855e3f74bf01c8ac',
  },
};

// RFC 4180: quoted cells may hold commas, doubled quotes and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function loadRegistry(entry) {
  const text = fs.readFileSync(new URL(entry.file, REGISTRY_DIR), 'utf8');
  const digest = crypto.createHash('sha256').update(text.replace(/\r/g, '')).digest('hex');
  assert.equal(digest, entry.sha256, `${entry.file} is not the pinned registry file: refresh the pin on purpose, together with the gate table`);
  const [header, ...rows] = parseCsv(text);
  assert.ok(header.length >= 6, `${entry.file} header`);
  assert.equal(rows.length, entry.rows, `${entry.file} row count`);
  return rows;
}

const stripNote = (cell) => cell.replace(/\s*\[\d+\]\s*$/, '').trim();

function ipv6Value(text) {
  const [head, tail = null] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === null || tail === '' ? [] : tail.split(':');
  const fill = tail === null ? [] : Array(8 - left.length - right.length).fill('0');
  const groups = [...left, ...fill, ...right];
  assert.equal(groups.length, 8, text);
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}
const ipv4Value = (text) => text.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
const ipv6Text = (value) => Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(112 - 16 * i)) & 0xffffn).toString(16)).join(':');
const ipv4Text = (value) => [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');

function blockOf(cidr, width) {
  const [text, length] = cidr.split('/');
  const hostBits = BigInt(width - Number(length));
  const base = width === 128 ? ipv6Value(text) : ipv4Value(text);
  const first = (base >> hostBits) << hostBits;
  return { cidr, length: Number(length), first, last: first + (1n << hostBits) - 1n };
}
const within = (block, value) => value >= block.first && value <= block.last;
const sameBlock = (a, b) => a.first === b.first && a.last === b.last;

// A special-purpose registry row can name several blocks in one cell ("192.0.0.170/32, 192.0.0.171/32").
function specialRows(registry, width) {
  return loadRegistry(registry).flatMap((row) => stripNote(row[0]).split(/\s*,\s*/).map((cidr) => ({
    block: blockOf(cidr, width),
    name: stripNote(row[1]),
    reachable: stripNote(row[8]) === 'True',
  })));
}

const unicast = loadRegistry(REGISTRIES.unicast).map((row) => ({ block: blockOf(row[0], 128), designation: row[1], status: row[5] }));
const special6 = specialRows(REGISTRIES.special6, 128);
const special4 = specialRows(REGISTRIES.special4, 32);

// IPv6 is public when it lies in a block IANA has ALLOCATED to a registry, except the two ALLOCATED rows that are themselves rows
// of the special-purpose registry (2001::/23 and 2002::/16), and except every special-purpose row that is not globally reachable
// (2001:db8::/32 sits inside the APNIC block 2001:c00::/23).
const allocated6 = unicast.filter((row) => row.status === 'ALLOCATED' && !special6.some((special) => sameBlock(special.block, row.block)));
const notReachable6 = special6.filter((row) => !row.reachable);
const expectedPublic6 = (value) => allocated6.some((row) => within(row.block, value)) && !notReachable6.some((row) => within(row.block, value));

// IPv4 is public unless it lies in a special-purpose row that is not globally reachable or in the multicast block 224.0.0.0/4
// (RFC 5771; the IPv4 Address Space registry, not the special-purpose registry).
const MULTICAST4 = blockOf('224.0.0.0/4', 32);
const notReachable4 = special4.filter((row) => !row.reachable);
const expectedPublic4 = (value) => !within(MULTICAST4, value) && !notReachable4.some((row) => within(row.block, value));

function check6(value, why) {
  const address = ipv6Text(value);
  const actual = classifyAddress(address);
  assert.notEqual(actual, 'invalid', `${why}: ${address}`);
  assert.equal(actual === 'public', expectedPublic6(value), `${why}: ${address} is ${actual}`);
}
function check4(value, why) {
  const address = ipv4Text(value);
  const actual = classifyAddress(address);
  assert.notEqual(actual, 'invalid', `${why}: ${address}`);
  assert.equal(actual === 'public', expectedPublic4(value), `${why}: ${address} is ${actual}`);
}

const MAX6 = (1n << 128n) - 1n;
const MAX4 = (1n << 32n) - 1n;

test('the registry files are the pinned IANA downloads and the gate cites the one its IPv6 table comes from', () => {
  const gateSource = fs.readFileSync(new URL('../../lib/trust-next/enforcement-gate.mjs', import.meta.url), 'utf8');
  assert.ok(gateSource.includes(REGISTRIES.unicast.downloaded_sha256), 'the gate comment must cite the hash of the unicast registry it was built from');
  assert.ok(gateSource.includes('2026-10-09'), 'the gate comment must carry the retrieval date');
  assert.equal(unicast.length, REGISTRIES.unicast.rows);
  assert.deepEqual([...new Set(unicast.map((row) => row.status))].sort(), ['ALLOCATED', 'RESERVED']);
  // Two ALLOCATED rows are special-purpose space and are removed; the other 34 are the blocks that can hold a public address.
  assert.deepEqual(unicast.filter((row) => row.status === 'ALLOCATED' && special6.some((special) => sameBlock(special.block, row.block))).map((row) => row.block.cidr), ['2001::/23', '2002::/16']);
  assert.equal(allocated6.length, 34);
  assert.ok(special6.length > 0 && special4.length > 0);
});

test('IPv6: every row boundary of the unicast and special-purpose registries is classified as the registries say', () => {
  const rows = [...unicast.map((row) => ({ ...row, why: `unicast ${row.status} ${row.block.cidr}` })), ...special6.map((row) => ({ ...row, why: `special-purpose ${row.block.cidr}` }))];
  for (const row of rows) {
    const { first, last } = row.block;
    check6(first, `first address of ${row.why}`);
    check6(last, `last address of ${row.why}`);
    check6((first + last) >> 1n, `middle of ${row.why}`);
    if (first > 0n) check6(first - 1n, `address before ${row.why}`);
    if (last < MAX6) check6(last + 1n, `address after ${row.why}`);
  }
  // The edges of the address space itself.
  check6(0n, 'the lowest address');
  check6(MAX6, 'the highest address');
});

test('IPv6: a sweep of the whole space, 65536 first groups and every second group of the blocks longer than /16, matches the registries', () => {
  for (let group = 0; group <= 0xffff; group += 1) {
    for (const second of [0x0000, 0x8000, 0xffff]) {
      const value = (BigInt(group) << 112n) | (BigInt(second) << 96n) | 1n;
      const address = `${group.toString(16)}:${second.toString(16)}::1`;
      const actual = classifyAddress(address);
      assert.notEqual(actual, 'invalid', address);
      assert.equal(actual === 'public', expectedPublic6(value), `${address} is ${actual}`);
    }
  }
  const narrow = new Set([...allocated6, ...unicast, ...special6].filter((row) => (row.block ?? row).length > 16).map((row) => Number((row.block ?? row).first >> 112n)));
  assert.ok(narrow.has(0x2001) && narrow.has(0x2003) && narrow.has(0x2620) && narrow.size >= 5, 'the blocks longer than /16 are found in the registries');
  for (const group of narrow) {
    for (let second = 0; second <= 0xffff; second += 1) {
      const value = (BigInt(group) << 112n) | (BigInt(second) << 96n) | 1n;
      const address = `${group.toString(16)}:${second.toString(16)}::1`;
      assert.equal(classifyAddress(address) === 'public', expectedPublic6(value), address);
    }
  }
});

test('IPv6: the Codex review examples and the other reserved or unallocated ranges are not public', () => {
  // IANA lists 3f00::/9 and 3ffe::/16 as RESERVED, 2001:6000::/19 is a gap between two allocations, and 2000::/16 lies below the first one.
  const refused = ['3f00::1', '3ffe::1', '3ff0::1', '2d00::1', '2e00::1', '3000::1', '2000::1', '2001:6000::1', '2001:7fff:ffff::1', '2a20::1', '2c10::1', '2f00::1', '::808:808', '4000::1', '8000::1', 'e000::1'];
  for (const address of refused) assert.equal(classifyAddress(address), 'reserved', address);
  // Allocated space stays public: the last address of a block and the first address of the next one.
  for (const address of ['2001:5fff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:8000::1', '2c0f:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2600::1', '2620:4f:8000::1', '2a00:1450:4001::1']) {
    assert.equal(classifyAddress(address), 'public', address);
  }
});

test('IPv6: the globally reachable special-purpose rows that sit in space IANA has not allocated stay refused (fail closed)', () => {
  // IANA marks these rows globally reachable, but each one sits inside 2001::/23, 64:ff9b::/96 or other space that is not an ALLOCATED
  // unicast block. The gate refuses them: a program that needs one of them is granted the exact literal. Derived from the registry.
  const reachable = special6.filter((row) => row.reachable);
  assert.deepEqual(reachable.filter((row) => !expectedPublic6(row.block.first)).map((row) => row.block.cidr),
    ['64:ff9b::/96', '2001:1::1/128', '2001:1::2/128', '2001:1::3/128', '2001:3::/32', '2001:4:112::/48', '2001:20::/28', '2001:30::/28']);
  assert.deepEqual(reachable.filter((row) => expectedPublic6(row.block.first)).map((row) => row.block.cidr), ['2620:4f:8000::/48']);
  for (const row of reachable) {
    const isPublic = row.block.cidr === '2620:4f:8000::/48';
    // 64:ff9b::/96 wraps an IPv4 address, so the class it reports names the wrapped address (64:ff9b:: wraps 0.0.0.0).
    for (const value of [row.block.first, row.block.last]) {
      const actual = classifyAddress(ipv6Text(value));
      assert.equal(actual === 'public', isPublic, `${row.block.cidr}: ${ipv6Text(value)} is ${actual}`);
      assert.notEqual(actual, 'invalid', row.block.cidr);
    }
  }
});

test('IPv4: every row boundary of the special-purpose registry and a sweep of the address space match the registry', () => {
  for (const row of special4) {
    const { first, last } = row.block;
    const why = `special-purpose ${row.block.cidr} (${row.name})`;
    check4(first, `first address of ${why}`);
    check4(last, `last address of ${why}`);
    check4((first + last) >> 1n, `middle of ${why}`);
    if (first > 0n) check4(first - 1n, `address before ${why}`);
    if (last < MAX4) check4(last + 1n, `address after ${why}`);
  }
  check4(0n, 'the lowest address');
  check4(MAX4, 'the highest address');
  check4(MULTICAST4.first, 'the first multicast address');
  check4(MULTICAST4.last, 'the last multicast address');
  check4(MULTICAST4.first - 1n, 'the address before multicast');
  for (let a = 0; a <= 255; a += 1) {
    for (let b = 0; b <= 255; b += 1) {
      for (const c of [0, 99, 255]) {
        const value = (BigInt(a) << 24n) | (BigInt(b) << 16n) | (BigInt(c) << 8n) | 1n;
        const address = `${a}.${b}.${c}.1`;
        const actual = classifyAddress(address);
        assert.notEqual(actual, 'invalid', address);
        assert.equal(actual === 'public', expectedPublic4(value), `${address} is ${actual}`);
      }
    }
  }
});

test('IPv4: the deprecated 6to4 relay block 192.88.99.0/24 is not public, its neighbours are, and the globally reachable rows are listed', () => {
  for (const address of ['192.88.99.0', '192.88.99.1', '192.88.99.2', '192.88.99.255']) assert.equal(classifyAddress(address), 'reserved', address);
  for (const address of ['192.88.98.255', '192.88.100.0']) assert.equal(classifyAddress(address), 'public', address);
  // The row has no flags at all in the registry: it was deprecated in 2015, so only the missing flags make it not reachable.
  const relay = special4.find((row) => row.block.cidr === '192.88.99.0/24');
  assert.equal(relay.reachable, false);
  const reachable = special4.filter((row) => row.reachable);
  // 192.0.0.9 and 192.0.0.10 are globally reachable rows inside 192.0.0.0/24, which is not: the whole /24 stays refused.
  assert.deepEqual(reachable.filter((row) => !expectedPublic4(row.block.first)).map((row) => row.block.cidr), ['192.0.0.9/32', '192.0.0.10/32']);
  assert.deepEqual(reachable.filter((row) => expectedPublic4(row.block.first)).map((row) => row.block.cidr), ['192.31.196.0/24', '192.52.193.0/24', '192.175.48.0/24']);
  for (const row of reachable) {
    const expected = expectedPublic4(row.block.first) ? 'public' : 'reserved';
    assert.equal(classifyAddress(ipv4Text(row.block.first)), expected, row.block.cidr);
    assert.equal(classifyAddress(ipv4Text(row.block.last)), expected, row.block.cidr);
  }
});
