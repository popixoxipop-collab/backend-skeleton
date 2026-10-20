# BSKEL context slice — bounded, one-hop import-aware source evidence

`bskel context slice` is an **additive, experimental, read-only advisory source-slicing command** that does NOT modify `sbf.context-packet/1`, the legacy `context pack` or `context focus` contract, BECODER plan authority, BEVAL independent source checks, or release gates.

```sh
bskel context slice --contract specs/001-feature/contracts/001-feature.schema.json \
  --operation get_items --revision <immutable-commit> \
  --max-bytes 8192 --max-dependencies 3 --max-handler-lines 100 --json
```

The result contains the selected source handler excerpt and up to three **directly referenced local Python import symbols**, each with a committed Git blob OID, original-file SHA-256, exact-byte excerpt SHA-256, original source line range and byte count. It refuses to truncate a dependency silently and marks unresolved local relative imports, unknown import forms and budget limits as `advisory_incomplete`. External packages are not loaded. File contents are untrusted data and are **never** executed as instructions or given release/execution authority.

The source is bounded to one Git commit; Git replace objects and lazy fetching are disabled. Symlinked Git source entries and binary/non-UTF-8 files are not accepted for local dependency extraction. The command never imports Python files or runs application code. It may abstain instead of selecting an ambiguous or unsupported handler. Languages besides Python currently return the focused excerpt plus `language_import_analysis_unsupported`; **do not** represent that as a complete import graph.

## Security and semantic limitations

- Only **one hop** of static local Python `from module import symbol` statements is inspected. It does not resolve transitive calls, dynamically constructed imports, dependency injection, re-exports or runtime route prefixes.
- Imported helpers are identified lexically, not by an actual Python AST/compiler. The contents of strings/docstrings, aliases, module-member imports and multiple declarations can confuse such heuristics; treat them as incomplete hints and use human/BEVAL review.
- Source excerpts may not contain complete application state or backend dependencies. The result's `advisory_complete` does **not** mean equivalent runtime behavior, full import closure, full source provenance authority or BEVAL `verified`.
- Exact byte budget includes the handler and all dependency snippets; if there is insufficient space, the dependency is omitted and its omission is recorded.
- Never present a local slice as a signed or authenticated BSKEL context packet. For the authoritative flow, separately create an original `sbf.context-packet/1` with pinned full source bytes, run BECODER `plan --context-packet`, and require the BEVAL `context check` verdict.

## Development integration smoke (not unseen holdout)

Four isolated deterministic Python GET fixtures (`ping`, `greeting`, `products`, `price`) were given local source imports. Each route has a fixed Git commit and a synthetic source-derived SBF contract. The triad was exercised: original BSKEL source packet, BECODER `plan`, deterministic BECODER `emit` of **18 frontend source files per case**, BECODER `emit --check`, BEVAL independent Git/plan `verified`, then two Codex-generated Node handler arms evaluated with the original BEVAL hardened DockerRunner and explicit source-derived HTTP probes.

| Measured item | Full pinned source | One-hop import slice |
|---|---:|---:|
| Isolated test cases passing | 4/4 | 4/4 |
| Real Docker HTTP checks | 14/14 | 14/14 |
| Model calls | 4 | 4 |
| Source excerpt bytes | 5,534 | 665 |
| Provider-reported input tokens | 66,580 | 64,967 |
| Output tokens | 842 | 701 |

Those are **development fixture checks only**. They do not demonstrate general backend implementation success, production-level safety or statistical significance. The model provider's server-side prompt cache and user/API cost remain uncontrolled, so even the observed input-token difference is not necessarily reproducible. The BECODER-generated frontend scaffold was emitted and deterministically checked, not tested as a deployed production UI.

The authoritative original BEVAL DockerRunner ran generated code in memory-/CPU-/PID-limited read-only containers on an internal Docker network. No generated code was executed on the host. No PR was merged and no operating release activated.

## Evaluation next steps

Use new previously unseen public repositories, immutable full-SBF contracts and independent runtime oracles; include **POST/security and restart/recovery behavior**, deliberately complex dynamic Python dependencies and other languages. Compare to an rg+AST helper-only selection baseline under both equal source-byte and equal provider-token constraints. Measure BECODER-generated frontend runtime behavior and BEVAL end-to-end functional equivalence separately. Keep all codegen outputs, BEVAL audits, SHA-256 and failures, without removing incomplete trials.

The feature remains a Draft PR until GitHub CI, independent code review and stronger behavioral holdouts pass.


## Independent red-team audit fixes (2026-10-20)

The first read-only coding-model audit identified five concrete failures
in the development implementation. These were corrected before opening
a PR, with malicious and edge-case pinned Git fixtures.

1. Local secret folders, credential-like import paths and token module
   names are rejected; omitted references are reported as incomplete.
2. Python line comments now end on real LF; quoted strings and
   triple-quoted docstrings are masked before matching import references.
3. Multiline handler/helper signatures and multiline string/dictionary
   bodies are retained instead of silently truncated as complete.
4. The entire bounded Git source is scanned for imports (no first-400-lines
   cutoff). Bare module-member and dynamic imports are reported as unresolved.
5. Absolute imports are never attributed to unrelated basename-only
   matches in another package root.

The previous four-case codegen smoke uses single-line signatures and
is development evidence, not an untouched holdout. A new multiline
signature regression preserves the full handler body and helper. The
original raw model/HTTP evidence was not rewritten.

Focused security, CLI, packet and docs regression: 184/184 PASS.
Post-hardening byte-for-byte excerpt compatibility for four old
development fixtures: 4/4 PASS. A full local test attempt exceeded
660 seconds; it is NOT counted as a PASS. GitHub CI must still complete.

The isolated triad smoke checked BSKEL complete packet, BECODER
deterministic plan and frontend emit (18 files per case), BEVAL pinned
Git source verification and eight model-generated Node.js handlers.
The original BEVAL DockerRunner observed 14/14 HTTP checks in each
of the full-context and reduced-context arms. XOX independently
verified the EOE receipts and eight raw model SHA hashes: cross-host
proof SHA-256 7a6cca0411b7b7f8193923864a4a92c523f98b017c5c37707327bb4896f02490.

Promotion remains prohibited. This is a source context proof of
concept, NOT complete language dependency closure, a generalized
model benchmark, production security certification or runtime
deployment.
