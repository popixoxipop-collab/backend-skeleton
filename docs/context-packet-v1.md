# Context packet v1

`bskel context pack` builds a bounded onboarding packet for one feature from one committed Git snapshot. BECODER carries this packet into its existing UI/client SurfacePlan; BEVAL independently verifies the plan's links and core contract projections against the original repository and an externally expected commit.

The design adapts the selective discovery and compact handoff approach of [ECC codebase-onboarding](https://github.com/affaan-m/ECC/tree/main/skills/codebase-onboarding). The implementation is original BSKEL code. It does not install ECC hooks, create a root instruction file or run a model observer.

## Command

Run inside the backend repository whose committed feature contract should be packaged:

```sh
bskel context pack \
  --contract specs/001-widget/contracts/001-widget.schema.json \
  --revision HEAD \
  --files src/app.mjs,test/widget.test.mjs \
  --max-files 16 --max-bytes 65536 \
  --out context/widget.json --json
```

`--json` prints exactly one packet document. Without `--json`, stdout is a compact Markdown navigation guide. `--out` writes only the JSON packet to that path, resolved from the repository root; it does not create a guide file automatically. Omit `--out` for no file writes. Use normal stdout redirection to save a guide. `--quiet` suppresses the human guide and does not suppress JSON.

`--contract` and `--files` are normalized repository-relative POSIX paths, interpreted literally. The comma-separated `--files` CLI cannot name a file containing a comma; callers needing that filename can use the JavaScript API's array. No shell glob expansion or path decoding occurs inside BSKEL. Duplicate requested paths are reduced to their first occurrence, and the contract path is always carried separately.

`--revision` defaults to `HEAD`, is resolved once to a full commit OID and thereafter is never used as a mutable ref. Git replacement objects and lazy fetches are disabled. Contract and source content come from regular committed blobs, never from working-tree text, symlinks or submodules. A locally unavailable object is an error, with no network fallback.

This command does not require or modify a preflight, scan, contract or implementation gate. The feature contract must already be valid against BSKEL's current `feature-contract.schema.json` (`sbf_contract: "9"`). It is carried as exact JSON text with no recreated operation semantics. Warnings, `body: "unknown"`, omitted security and explicitly empty security remain distinct.

## Selection and bounds

The contract is always first and counts toward both budgets. Explicit source paths have priority. Next, existing root metadata is requested in this fixed order:

```text
AGENTS.md, CLAUDE.md, package.json, pyproject.toml, requirements.txt,
pom.xml, build.gradle, build.gradle.kts, Gemfile, Cargo.toml, go.mod, README.md
```

Absent optional root files are not requested. An explicitly requested absent path receives an omission. There is no automatic recursive repository scan and no claim that the selected files describe the entire architecture. The user chooses relevant source and test paths. Roles (`source`, `test`, `manifest`, `documentation`, `instructions`) are filename navigation hints, not semantic or execution evidence.

The default budget is 16 files and 65,536 raw UTF-8 bytes; allowed limits are 1–128 files and 1–1,048,576 bytes. A contract exceeding the byte budget is an error. Each source either fits whole or is omitted whole. A source omitted for size does not prevent a smaller later source from fitting. No model token counts are estimated.

| Omission reason | Meaning |
| --- | --- |
| `not_in_snapshot` | The requested path is absent from the selected commit. |
| `not_regular_file` | The path is a tree, symlink, submodule or other non-regular entry. |
| `non_utf8` | The blob cannot round-trip as exact UTF-8 text. |
| `file_budget` | The contract and already selected files exhaust the file limit. |
| `byte_budget` | Including this entire blob would exceed the byte limit. |

Checks occur in path existence, regular mode, file budget, byte budget, UTF-8 order. `selection.complete` is exactly `omitted.length === 0`: all requested context was included. It does not imply complete contract semantics, implementation quality or complete codebase knowledge. Exit 0 means the packet was produced; it may still contain explicit omissions. Invalid arguments, invalid contracts and unavailable Git snapshots use the existing exit 14 diagnostic path.

## Normative wire shape

The structural schema is [`schemas/context-packet.schema.json`](../schemas/context-packet.schema.json). V1 has exactly these top-level fields, with no timestamps or mutable absolute paths:

| Field | Contract |
| --- | --- |
| `schema` | Exactly `sbf.context-packet/1`. |
| `repository` | Exactly `{commit, tree}` with full lowercase 40- or 64-digit Git OIDs. Commit and tree together identify the snapshot. |
| `contract` | Exactly `{path, blob_oid, sha256, bytes, content}`. `content` is the original UTF-8 JSON text, `sha256` hashes those raw bytes and `bytes` is their length. |
| `sources` | Ordered records with the same five file fields plus `role`. Contract path is excluded. |
| `selection` | Exactly `{requested_paths, omitted, complete}`. Each omission is exactly `{path, reason}`. |
| `budget` | Exactly `{max_files, max_bytes, used_files, used_bytes}`. Limits include the contract. |
| `packet_sha256` | Canonical SHA-256 of every other field as specified below. |

Paths must be unique, normalized relative POSIX paths: no absolute paths, Windows drive prefix, backslashes, NUL, empty segments or `.`/`..` segments. Names are never shell instructions. Source and contract blobs must have Git modes `100644` or `100755`. Exact UTF-8 includes byte order marks, CRLF and final newlines when present in source content; invalid UTF-8 is never replaced with a replacement character.

Consumers must enforce the structural schema **and** these invariants:

1. Each requested path appears exactly once in either `sources` or `omitted`, with no overlaps or extras. Each list preserves requested priority order. The contract appears in neither list.
2. Every content field round-trips exactly as UTF-8; every file's byte length and SHA-256 match its content. SHA-256 is always 64 lowercase hexadecimal digits.
3. `used_files === 1 + sources.length`; `used_bytes === contract.bytes + sum(sources.bytes)`. Both are within the declared limits.
4. `selection.complete === (selection.omitted.length === 0)`.
5. Remove only the top-level `packet_sha256`. Recursively sort object keys with JavaScript's default `.sort()`, preserve array order, serialize with UTF-8 `JSON.stringify` and no whitespace or trailing newline, then hash those bytes with SHA-256. Preserve own keys such as `__proto__` as JSON data during canonicalization.
6. Parse the preserved contract and require the supported feature-contract version and shape. Do not weaken or recreate its original operations, warnings, completeness or unknowns.

A packet checksum provides integrity, not authentication. A producer validating its own output is insufficient independent proof of snapshot provenance. BEVAL must read the real Git objects with replacements and lazy fetch disabled, require the caller's externally supplied expected commit, verify the tree and regular blob mode/OID/content, and verify BECODER's operation and plan linkage. Matching content in a different commit is not a match to the intended commit.

## Product boundary

Packet text, including `AGENTS.md`, `CLAUDE.md`, manifests and scripts, is source data to inspect. It supplies no approval to execute commands and no evidence that tests have run. The context guide does not reproduce source text as active instructions. Neither a packet nor a downstream traceability verdict certifies functional implementation, security, official review acceptance, a metric improvement, release promotion or model superiority.

V1 intentionally provides the shared context foundation only. Repeated pattern learning should use separately verified evaluation outcomes; v1 performs no automatic learning, confidence scoring or promotion.

## JavaScript API and focused verification

### End-to-end CLI use

Run this command sequence from the backend repository root. The contract and selected source files must already exist in the chosen commit. Obtain the expected commit from the repository you intend to inspect, separately from the packet being evaluated.

```sh
snapshot=$(git rev-parse HEAD)
bskel context pack \
  --contract specs/001-widget/contracts/001-widget.schema.json \
  --revision "$snapshot" --files src/app.mjs,test/widget.test.mjs \
  --out context.json --json > /dev/null
becoder plan --context-packet context.json \
  --handoff-out agent-handoff --json > plan-record.json
beval context check --packet context.json --plan plan-record.json \
  --repo . --expect-commit "$snapshot" --json
```

`plan-record.json` is BECODER's complete CLI JSON record: `{plan, readWarnings, context_handoff}`. The `surface-plan.json` in the handoff directory contains only the ordinary SurfacePlan and is not a replacement for that record. The handoff directory also contains `AGENT.md`, `context-packet.json` and `context-handoff.json` for development work.

BEVAL returns `status: "verified"` (exit 0), `"incomplete"` (exit 3) or `"invalid"` (exit 2). Argument errors use exit 1. These are context and core contract-to-plan checks, not a functional backend test or a verdict about model quality.

The optional cross-repository smoke runner requires explicit peer checkouts and creates only a small temporary FastAPI fixture:

```sh
node scripts/context-triad-smoke.mjs \
  --becoder-dir ../backend-decoder --beval-dir ../Backend-evaluation
```

It uses BSKEL's existing scanner and OpenAPI reconciliation to create a contract, then invokes the three product CLIs. It checks legacy plan equality, missing versus explicit empty security, pinned Git evidence despite working-tree changes, mismatched expected commits, rehashed forged evidence, lost or weakened operations, and budget omissions. It does not call a model, backend server or database.

### Library API

```js
import { createContextPacket, renderContextGuide } from './lib/context-packet.mjs';
const packet = createContextPacket({
  repoRoot: '/path/to/backend',
  contractPath: 'specs/001-widget/contracts/001-widget.schema.json',
  revision: 'HEAD',
  files: ['src/app.mjs', 'test/widget.test.mjs'],
  maxFiles: 16,
  maxBytes: 65536,
});
const guide = renderContextGuide(packet);
```

Run only the new focused producer test file when verifying this slice:

```sh
node --test test/context-packet.test.mjs
```

The tests invoke the real product CLI with temporary committed Git fixtures: exact bytes, stable snapshot reads despite worktree and replacement changes, whole-file omissions, invalid UTF-8 and paths, malformed contracts, literal metacharacter filenames and output/help behavior. They do not run backend application tests or infer a backend feature pass.

The initial cross-repository implementation and verification record is in
[the 2026-10-19 validation report](context-triad-validation-2026-10-19.md).
