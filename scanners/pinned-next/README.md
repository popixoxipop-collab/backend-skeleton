# Pinned Next.js source inspector — product integration candidate

**Status:** Opt-in, static-only backend-skeleton product integration on a local unmerged/unpushed worktree. **Not a runtime-certified scanner, not an independent trust certificate, not a production release.**

## Entry points

The explicit CLI subcommand is:

```text
bskel scan pinned-next
  --commit <exact lowercase 40-hex Git commit>
  --git-exe <absolute Git binary>
  --git-sha256 <64-hex SHA-256 of binary>
  --git-dir <absolute trusted Git admin directory>
  --common-dir <absolute trusted common object store>
  [--list-projects | --project <repo-relative-path> | --all-projects] [--json]
```

The Git executable and object-store trust are **caller-selected and not independently authorized**. The result exposes `trust.externallyAuthorized=false`. Do not present the report as a source certificate or signed approval. This is an opt-in alternate **source selector** for static API discovery; the unmodified `bskel scan` path and existing adapter registry remain intact.

For backend code, use the opt-in SDK:

```js
import { pinnedNextSourceAdapter } from './scanners/pinned-next/next-product-sdk.mjs';
const source = {
  commit: '<exact Git commit>',
  gitExecutable: '/absolute/host-verified/git',
  gitExecutableSha256: '<64hex>',
  gitDir: '/absolute/approved/admin-dir',
  trustedCommonDir: '/absolute/approved/common-store',
};
const listing = pinnedNextSourceAdapter.listProjects(source);
const selected = pinnedNextSourceAdapter.scanProject(source, 'apps/web');
const full = pinnedNextSourceAdapter.scanAll(source);
```

## Product behavior and exit contract

- Both `--flag=value` and `--flag value` spellings are accepted for string options, consistently with the existing `bskel` parser; boolean selectors remain bare flags only.
- `--list-projects` returns deterministic Next.js app identities and server-source counts.
- `--project` returns just that app; unknown/path-traversing selections are refused.
- `--all-projects` returns a report with project identity per HTTP endpoint, without combining different apps by URL alone.
- Without a selector, an unambiguous single app is auto-scanned; multiple apps return `status=selection-required` and exit code 3, never choose the first silently.
- Missing/invalid package manifests are reported as `catalog.incomplete`. Automatic/whole-repo incomplete outputs carry a report and exit code 4; explicitly selected-app scans are allowed but marked incomplete.
- Bad Git executable hash, symbolic commit, bad source store/paths are refused; malformed flags use the normal `bskel` BAD_ARGS exit 14.
- The command follows the existing CLI diagnostic convention: `--json` prints a standard `sbf.cli-diagnostic/1` error envelope to stdout for payload-less errors; an informational nonzero report is one JSON document, not a second diagnostic. `--quiet --json` still retains JSON output.

The static parser supports bounded Next.js App Router explicit method exports, simple dynamic segments, route groups and literal basePath. It **does not** infer runtime endpoints, route auth, body/schema, Pages API control-flow methods, catch-all/intercepting/parallel forms or framework-generated method semantics. Output keeps `runtimeCertified=false`, `operationRegistrationAllowed=false`; the SDK advertises `api.operations=false`.

## Product integration scope and review

The candidate CLI is dispatched by `bin/bskel.mjs` with one additional explicit branch. Its flag vocabulary is added to `lib/cli.mjs`. The existing shared scanner `scanners/index.mjs`, zero-registration `scanners/registry.mjs`, product adapter descriptors and `package.json` are unchanged.

No new `scanners/adapters/*.mjs` leaf is installed: merely importing pinned-source code must not silently make it a production adapter.

This is a **reviewable local Git branch**, not approved source admission. New paths in `scanners/pinned-next/**` and edits to `bin/bskel.mjs` / `lib/cli.mjs` are **outside the old T13 five-path/108-pin post-baseline decision scope**. T00 must first approve the exact expanded changed-file set, owner/lease and CAS; T19 must independently review Git-object source authority/TOCTOU and scanner completeness; T23 owns product packaging and promotion. Do not modify `adapters/http-wave-bc/BASELINE.json` or the historical allowlist to conceal the drift.

## New checks

- `test/http-wave-bc/pinned-next-integration.test.mjs`: 16 synthetic test-only CLI↔SDK integration cases (no real target JS execution).
- `test/cli-contract.test.mjs`: shared command vocabulary/defaults/parser regression.
- `test/doc-integrity.test.mjs`: usage/help table synchronization.
- Node24.19.0 and Node26.7.0: **134/134 targeted tests PASS per runtime**, no skips, recorded in EOE outside the Git worktree.
- No previously refused T13-02 historical receipt, baseline-allowlist, P6 Node22 full, T12 full, T00 cy apply, or REPO_DENIED Codex operation was invoked.

## Limitations

Caller-selected Git-object executable/storage authority is not independently signed; a trusted quiescent object store is required for the safety hypothesis. Endpoint detection is static-only. Node18/20 compatibility was not remeasured on this EOE host (runtimes not installed). This branch does not grant a right to commit to main, push, merge, modify the live scanner registry or activate a release.

**Classification:** `LOCAL_PRODUCT_INTEGRATION_CANDIDATE_SELF_TESTED` — T00 policy/T19 review/T23 release `PENDING`, production release `BLOCKED`.
