# BSKEL deterministic source discovery v1 (experimental)

This is a **read-only, local, Git-commit-pinned** source-file **ranking heuristic**. It is not AST call-graph proof, semantic API validation, repository-wide coverage, or an approval to execute snippets.

```sh
bskel context discover --contract specs/001-demo/contracts/001-demo.schema.json \
  --operation readPing --revision <40-character-commit> --max-selected-files 4 --json

bskel context pack --contract specs/001-demo/contracts/001-demo.schema.json \
  --auto-select --operation readPing --revision <40-character-commit> \
  --max-files 8 --max-bytes 65536 --json
```

When `--auto-select` is absent, `context pack` retains its previous behavior. `--auto-select` and `--files` conflict and are rejected. The automatically ranked source paths are converted to an ordinary **`sbf.context-packet/1`** using the existing exact-byte implementation, so BECODER and BEVAL require no schema change. For a complete selection receipt, separately save `context discover --json`. Do not interpret `packet.selection.complete` as proof of correct source discovery.

The scanner enumerates only regular tracked Git blobs at one immutable commit, ignores the mutable working tree, disables replace objects and lazy fetch, and refuses network fallback. No shell commands from source files, AGENTS.md, or README are executed. Eligible source extensions are Python, JavaScript/TypeScript, Java, Kotlin, Ruby, Go, Rust, C#, PHP. Obvious credentials, test/fixture/generated/vendor folders, symlinks, binary/non-UTF-8/oversized files are excluded. Example source directories remain eligible, as some apps live under examples.

Scoring is deterministic: exact operation symbol, quoted route literals, HTTP decorator/mapping, operation/route tokens in filenames, and bounded lexical occurrences. All signals are approximate: dynamic routing, aliasing, imports, controller prefixes, templated paths and generic operation names may cause omissions or false positives. The selection exposes only source matches and OIDs, not execution authority. It reports low confidence, ambiguity and scan budget exhaustion; a no-match automatic pack fails closed.

Bounds: up to 2,500 files and 8 MiB scanned by default; hard bounds 20,000 files / 32 MiB; each file <= 256 KiB; no fetching missing Git objects. Sort order and scoring are stable for an identical commit. The contract itself remains in the BSKEL packet exactly as committed.

## Frozen development calibration, **not holdout**

Before opening any future holdout source, the five already used development repositories gave **top-1=4/5, recall@4=5/5**. This is a tiny development diagnostic, not a general accuracy or robustness claim. The algorithm and limits were then frozen for untouched-route evaluation. The source selection was not tuned on future holdout tasks.

Development references: `fastapi-crud-ping`, `fastapi-sqlmodel-ping`, `fastapi-boilerplate-health`, `fastapi-langgraph-health`, `spring-hello`. The last uses an example source directory, which is intentionally eligible.

## Independent evaluation requirements

1. Select and freeze unknown source repositories, commits, operation IDs and gold handler locations **after this implementation commit**, and hash the manifest before running discovery on them.
2. Never tune the algorithm using scored holdout answers. Label missing candidate sources as non-retrieval, not success. Separate top-1, recall@4, false-positive rate, budget omission rate, source prompt bytes and model-task correctness.
3. Use an existing or separately vetted source-path oracle/route inventory, independently of this scorer, for gold verification. Keep complete source/prompt/response SHA and model usage per trial.
4. Do not count model LLM code generation task failures as retrieval successes, and do not present an A/B prompt-only study as verification of deployed backend behavior.
5. Preserve original BSKEL contract unknown/security semantics, BECODER deterministic plan, BEVAL independent Git-byte verification, and existing merge/promotion gates.

## Security review hardening on successor commit — 2026-10-20

The read-only independent Codex audit found five code-path flaws in the
original frozen source selector. This successor fixes them but does NOT
retroactively change the original 22-pair holdout results.

- Source discovery completeness is now false when scan budgets were exhausted,
  any eligible Git blob was rejected as oversized/binary/non-UTF8, matching
  candidates were truncated, the best match lacks callable declaration
  evidence, or leading candidates are ambiguous.
- The limit maxScanFiles now applies to **all inspected Git blobs**, including
  oversized objects skipped before content is read. New inspected_files
  explicitly reports the counter, separate from scanned_files.
- Tree paths are strictly UTF-8 decoded without replacement characters.
  Contracts must be regular committed blobs (no symlink) and their bytes are
  read by immutable Git OID with a bounded byte count.
- Comments and Python docstrings cannot produce strong declaration signals.
  String contents are not accepted as executable function declarations.
  Route heuristics remain approximate, not a replacement for parser/AST proof.
- Automatic context packing fails closed on an incomplete discovery. Inspect
  the separate context discover JSON receipt (including incomplete_reasons
  and omitted_matching_candidates), then manually review and use explicit
  context pack --files if necessary. Automatic packing has no bypass flag.

The existing sbf.context-packet/1 schema is unchanged. In that schema,
selection.complete refers ONLY to the explicit requested source paths. It
does not certify repository coverage, retrieval completeness, or functional
correctness. The new discovery completeness verdict is separately reported.

Adversarial tests cover: Git raw invalid-UTF8 tree entries via git mktree
(even on Macs forbidding invalid filenames), symlinked contracts, oversized
entries circumventing scan limits, matching candidate truncation, malicious
line/block/docstring comments and strings, and fail-closed auto-pack.

Prior 22-pair holdout: selector SHA 9df94ea80b67ad844e9bc92bc7e2d9a81b7e7382.
Repeating those 22 original tasks on this successor is POST-HOC compatibility
regression, NOT a new untouched holdout. No production merge or promotion
should rely on the old results as evidence for this successor.
