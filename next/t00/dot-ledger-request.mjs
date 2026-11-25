import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareDotPromotionRequest, verifyPromotionAuthorization } from './promotion-authority.mjs';

const authority = {
  schema: 't00.met-promotion-authority/1',
  dotPublicDer: 'MCowBQYDK2VwAyEAS/MHuNBaVdwLobRLZ8sMydOQIsYO3YhzG3+wxyqKmM0=',
  productPublicDer: 'MCowBQYDK2VwAyEARSKqohZkpsVC29H4Sgo9gzvdwh5hzOLqpbT3DcOt/s8=',
  scopes: { 'T03-06': { repository: 'popixoxipop-collab/backend-skeleton', repositoryId: 1334919554,
    scope: 'historical-installed-package-replay' } },
};

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function readBounded(file, limit, privateFile = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    requireIt(stat.isFile() && stat.size > 0 && stat.size <= limit &&
      (!privateFile || (stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600)),
    'HOLD_DOT_LEDGER_REQUEST_FILE');
    const bytes = fs.readFileSync(fd);
    requireIt(bytes.length === stat.size && fs.fstatSync(fd).mtimeMs === stat.mtimeMs, 'HOLD_DOT_LEDGER_REQUEST_FILE');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function run() {
  requireIt(process.argv.length === 4, 'HOLD_DOT_LEDGER_REQUEST_ARGUMENTS');
  const stateBytes = readBounded(process.argv[2], 1024 * 1024);
  const text = readBounded(process.argv[3], 8192).toString('utf8').trimEnd();
  const signed = /^T00-MET-ATTESTATION-V1 ([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{86})$/u.exec(text);
  requireIt(signed !== null && signed[0] === text, 'HOLD_DOT_LEDGER_ATTESTATION_FRAME');
  const attestation = { body: signed[1], signature: signed[2] };
  const now = Math.floor(Date.now() / 1000);
  const bytes = prepareDotPromotionRequest({ attestation, stateBytes, authority, now });
  const pem = readBounded(join(homedir(), '.local/state/t00-dot-publisher/ed25519.pem'), 4096, true);
  try {
    const key = createPrivateKey(pem);
    requireIt(key.asymmetricKeyType === 'ed25519' &&
      createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') === authority.dotPublicDer,
    'HOLD_DOT_LEDGER_REQUEST_KEY');
    const request = { body: bytes.toString('base64url'), signature: sign(null, bytes, key).toString('base64url') };
    verifyPromotionAuthorization({ envelope: { request, attestation }, authority, now });
    console.log(`T00-DOT-MET-PROMOTE-V1 ${request.body}.${request.signature} ${attestation.body}.${attestation.signature}`);
  } finally {
    pem.fill(0);
  }
}

try {
  run();
} catch (error) {
  console.error(/^HOLD_[A-Z_0-9]+$/u.test(error?.message ?? '') ? error.message : 'HOLD_DOT_LEDGER_REQUEST_UNEXPECTED');
  process.exitCode = 1;
}
