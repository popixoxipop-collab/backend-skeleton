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
