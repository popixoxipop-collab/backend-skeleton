// T13-04 P3 isolated capability: caller must explicitly pin a trusted
// executable and a Git common-object-store root. Not a production security
// authority, signature service, or safe interface for attacker-owned .git.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const authorities = new WeakSet();
const HEX64 = /^[a-f0-9]{64}$/;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

function trustedAbsoluteDirectory(target, label) {
  if (typeof target !== 'string' || !path.isAbsolute(target) ||
      path.normalize(target) !== target) throw Error(label + '_ABSOLUTE_PATH_REQUIRED');
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw Error(label + '_UNTRUSTED_DIRECTORY');
  }
  // macOS /var is a system-managed link to /private/var. Canonicalize
  // ancestor aliases, while refusing a symlink at the selected directory.
  // The caller still owns trust in the full canonical ancestor chain.
  return fs.realpathSync(target);
}
function regularMetadata(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw Error('GIT_METADATA_NOT_REGULAR');
  }
  return fs.readFileSync(file, 'utf8');
}
function localPolicyCheck(gitDir, commonDir) {
  const commondir = path.join(gitDir, 'commondir');
  let resolved = gitDir;
  try {
    const contents = regularMetadata(commondir, 1024).trim();
    if (!contents || contents.includes('\0')) throw Error('INVALID_GIT_COMMONDIR');
    resolved = path.resolve(gitDir, contents);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  if (resolved !== commonDir) throw Error('GIT_COMMONDIR_MISMATCH');
  for (const rel of ['objects', 'objects/info']) {
    trustedAbsoluteDirectory(path.join(commonDir, rel), 'GIT_OBJECTS');
  }
  // Any alternate object database is outside the chosen common-store root.
  try {
    fs.lstatSync(path.join(commonDir, 'objects/info/alternates'));
    throw Error('GIT_ALTERNATES_UNAPPROVED');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  const config = path.join(commonDir, 'config');
  const body = regularMetadata(config, 65536);
  // Conservatively refuse conditional includes, partial-clone/promisor
  // sources and non-SHA1 object repositories in this bounded prototype.
  if (/(^\s*\[\s*include(?:if)?\b|^\s*promisorRemote\b|promisor\s*=|partialClone\s*=|^\s*\[\s*extensions\b)/im.test(body)) {
    throw Error('GIT_CONFIG_EXTERNAL_AUTHORITY_UNAPPROVED');
  }
}
export function makeGitAuthority({
  gitExecutable, gitExecutableSha256, gitDir, trustedCommonDir,
} = {}) {
  if (typeof gitExecutable !== 'string' || !path.isAbsolute(gitExecutable) ||
      path.normalize(gitExecutable) !== gitExecutable) {
    throw Error('PINNED_GIT_EXECUTABLE_ABSOLUTE_REQUIRED');
  }
  if (!HEX64.test(gitExecutableSha256 ?? '')) throw Error('GIT_EXECUTABLE_SHA256_REQUIRED');
  const executableInfo = fs.lstatSync(gitExecutable);
  if (!executableInfo.isFile() || executableInfo.isSymbolicLink() ||
      fs.realpathSync(gitExecutable) !== gitExecutable) {
    throw Error('GIT_EXECUTABLE_NOT_TRUSTED');
  }
  if (sha256(fs.readFileSync(gitExecutable)) !== gitExecutableSha256) {
    throw Error('GIT_EXECUTABLE_SHA256_MISMATCH');
  }
  const chosenDir = trustedAbsoluteDirectory(gitDir, 'GIT_DIR');
  const common = trustedAbsoluteDirectory(trustedCommonDir, 'GIT_COMMON_DIR');
  localPolicyCheck(chosenDir, common);
  const result = Object.freeze({
    gitExecutable, gitExecutableSha256, gitDir: chosenDir, trustedCommonDir: common,
    trust_model: 'EXTERNALLY_SELECTED_EXECUTABLE_STORE_AND_EXACT_COMMIT',
  });
  authorities.add(result);
  return result;
}
export function requireGitAuthority(trust) {
  if (!authorities.has(trust)) throw Error('UNVERIFIED_GIT_EXECUTION_AUTHORITY');
  return trust;
}
// Do not forward caller's HOME/PATH, Git config overrides, custom protocol,
// network, credential, proxy, dynamic-loader, or Git object path environment.
// Git common dir and Git executable are previously checked capability inputs.
export const CLEAN_GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/var/empty',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
});
