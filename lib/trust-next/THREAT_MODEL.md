# T20 trust boundary threat model

Status: draft implementation for T20-01/T20-02. This document does not claim OS sandbox enforcement.

## Trust domains

1. **bskel first-party code** — installed package code and shipped adapters. Existing `scanners/registry.mjs` deliberately treats its own adapter directory as trusted executable code.
2. **user repository input** — source, manifests, route definitions, generated files, docs and fixtures. These are data by default, never instructions to bskel itself.
3. **external adapters/parsers/build helpers** — executable code that can read files, environment or network if imported/run without isolation. Never inherit first-party trust from an adapter name.
4. **runtime/oracle/candidate processes** — may be malicious or simply side-effectful. Original/oracle code is not implicitly safer than candidate code.
5. **secrets and credentials** — values remain outside manifests and artifacts. Only opaque secret references may cross the planning boundary.
6. **evidence/artifacts** — hashes/signatures prove byte identity/provenance properties, not behavioral correctness. Evidence must remain scoped to the run/profile that produced it.

## Assets

- repository source and generated output
- credentials, environment and local user files
- network reachability and service endpoints
- process namespace, devices and host resources
- immutable contracts, run bindings and evidence
- adapter/parser/runtime package identity

## Threats and required controls

| Threat | Initial control |
|---|---|
| User-controlled adapter directory causes import-time arbitrary code execution | Keep external adapters outside the existing zero-registration registry; require an explicit future trust loader and approved digest. |
| Source/build scripts execute during static analysis | Static analyzers receive bytes/facts; target initialization and build hooks require an explicit runtime profile. |
| Repository path traversal or sibling-prefix escape | Permission roots are repository-relative and segment-bound; `..`, absolute paths and backslashes are rejected by the manifest layer. |
| Ambient environment/secret leakage | Environment names and secret references are explicit allowlists; secret values are forbidden in the manifest. |
| Unbounded child processes/output | Process mode is deny-by-default; executable basenames and max-child/output/wall limits are explicit. |
| SSRF/general egress | Network mode is deny-by-default; allowlist entries are exact host+port pairs, not wildcard URLs. |
| Signed malicious/wrong behavior is treated as correct | Signature/provenance remains separate from semantic/runtime certification. |
| Revoked/stale dependency continues from cache | T20-04 will bind allowed digests and revocation policy into execution approval/cache keys. |
| Symlink/device/container escape | T20-03 must implement platform enforcement and malicious fixtures; this manifest alone is not a sandbox. |

## Non-goals of T20-01/T20-02

- no CLI flag that loads arbitrary adapter directories
- no target code execution
- no network or shell enforcement claim
- no signature/revocation implementation yet
- no production credential handling
- no change to existing adapter contract/schema or stable scanner behavior
