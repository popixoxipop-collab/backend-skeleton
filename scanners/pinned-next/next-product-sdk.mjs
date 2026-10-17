/**
 * Programmatic backend-skeleton source adapter candidate: pinned Git Next.js
 * static scanner. NOT the registered sbf.adapter/2 runtime adapter.
 *
 * This intentionally requires an explicit externally selected source store,
 * host Git executable, digest and exact commit. Trust in those choices is
 * NOT established by the constructor and is never promoted by a green scan.
 *
 * No target app evaluation, mutable worktree reads, network calls, registry
 * changes, issuer/witness/nonce service, or production runtime guarantees.
 */
import { makeGitAuthority } from './git-authority.mjs';
import { loadPinnedSnapshot } from './git-snapshot.mjs';
import { scanPinnedNextMonorepo, NextMonorepoError } from './next-monorepo.mjs';

export const PINNED_NEXT_SOURCE_PROFILE = Object.freeze({
  contract: 'backend-skeleton.pinned-source-adapter/1',
  id: 'typescript-nextjs',
  title: 'Next.js pinned Git-object static API scanner',
  verificationBasis: 'synthetic-only',
  sourceAuthority: 'caller-selected-not-attested',
  capabilities: Object.freeze({
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  }),
});

/**
 * @param {object} config
 * @param {object} config.source
 * @param {string} config.source.commit exact 40-hex source revision
 * @param {string} config.source.gitExecutable absolute externally verified Git
 * @param {string} config.source.gitExecutableSha256 SHA-256 of chosen executable
 * @param {string} config.source.gitDir absolute Git administrative dir
 * @param {string} config.source.trustedCommonDir approved common object store
 * @param {('auto'|'list'|'single'|'all')} [config.mode]
 * @param {string|null} [config.projectId]
 * @returns {object} deterministic static scan, caller-source trust unapproved
 */
export function inspectPinnedNextSource({
  source, mode = 'auto', projectId = null,
} = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      typeof source.commit !== 'string') {
    throw new NextMonorepoError('PINNED_SOURCE_CONFIG_REQUIRED');
  }
  const authority = makeGitAuthority({
    gitExecutable: source.gitExecutable,
    gitExecutableSha256: source.gitExecutableSha256,
    gitDir: source.gitDir,
    trustedCommonDir: source.trustedCommonDir,
  });
  const snapshot = loadPinnedSnapshot({
    gitAuthority: authority, commit: source.commit,
  });
  const output = scanPinnedNextMonorepo({ snapshot, mode, projectId });
  return Object.freeze({
    ...output,
    trust: Object.freeze({
      ...output.trust,
      gitExecutableSha256: authority.gitExecutableSha256,
    }),
  });
}

export const pinnedNextSourceAdapter = Object.freeze({
  ...PINNED_NEXT_SOURCE_PROFILE,
  inspect: inspectPinnedNextSource,
  listProjects: source => inspectPinnedNextSource({ source, mode: 'list' }),
  scanProject: (source, projectId) => inspectPinnedNextSource({
    source, mode: 'single', projectId,
  }),
  scanAll: source => inspectPinnedNextSource({ source, mode: 'all' }),
});
