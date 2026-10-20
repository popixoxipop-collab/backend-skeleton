# BSKEL focused source context (experimental; read only)

`bskel context focus` is an **additive, untrusted navigation hint**, separate from `bskel context discover` and the existing signed/independently verified `sbf.context-packet/1` workflow.

```sh
bskel context focus --contract specs/001-example/contracts/001-example.json \
  --operation readUser --revision <immutable-Git-SHA> \
  --max-bytes 8192 --max-candidates 4 --json
```

The command reuses the exact Git-commit-pinned discovery results, re-reads at most four shortlisted tracked Git blobs by their OID, checks the original blob bytes and SHA-256, and narrows the output to **one uniquely GET-decorated callable**. For Python and common Spring annotations it preserves the entire multiline GET decorator, the function declaration/signature and a short bounded source excerpt. It stops before the next same-level endpoint. If a valid unique decorated source cannot be identified or the excerpt would exceed the configured budget, the result is `abstained`, not a fabricated answer.

When discovery is complete the result can say `advisory_complete`; with truncated search candidates/scan limitations it says `advisory_incomplete`. **Neither value is BEVAL's `verified` status, production authorization, or proof of repository-wide semantic completeness.** Every excerpt has `trust: "untrusted-committed-source"` and must never be treated as executable instructions. The existing `context pack --files` and `context pack --auto-select` paths are unchanged by this feature.

All output source paths are sourced from a strict Git tree inventory (regular blobs, UTF-8 names, no symlink/credential candidates). The focused source data contains file identity, OID, full-source hash, excerpt hash, byte budget and original line range for later independent revalidation. Consumers must independently verify the exact commit/contract/source/excerpt before treating this as evidence; this command is **not a replacement** for the BECODER deterministic plan, BEVAL verifier, or existing release gate.

This is a **lexical GET declaration/decorator matcher**, not true language-wide AST parsing. It currently intentionally abstains on dynamic/decorated alias routes, ambiguous declarations, non-GET handlers, unsupported syntax, and files not among the bounded top-ranked candidates. The ranking/scanning cost still comes from the original BSKEL discovery pass. The focused excerpt does not transitively include dependencies/import closures.

## Development calibration, NOT new unseen holdout

In an already previously scored 22-route development set, focused selection chose the correct source file for **22/22**, abstained 0 times, and supplied **8,229 bytes total** of source excerpts. That dataset had already been opened and scored before this algorithm was written, so these are **post-hoc compatibility and byte-budget observations only**. They must not be presented as independently established general accuracy or a model token-cost result. The previous baseline source excerpts (25,150B `rg`, 27,634B AST/declarations, 57,512B unpruned BSKEL) remain frozen and unchanged.

Before claiming improved accuracy or token efficiency, freeze this code commit, then select new unused repositories and independently define source gold and paired model requests. Compare to a robust `rg`/Python-AST/declaration baseline at equal source byte cap, and measure actual source-byte use, provider token reports, abstentions and exact file-and-symbol success. Evaluate backend behavior separately; navigation correctness does not prove implementation correctness.
