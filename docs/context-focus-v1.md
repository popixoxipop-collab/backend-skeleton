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


## Restricted focused handler paths — security review follow-up

An independent read-only audit of the dependent context-slice feature found
that the original focus selector could retrieve a Python GET handler from
a tracked credential-like directory (for example app/secrets/token.py).
The parent focus command now refuses to emit **any** source excerpt if
any shortlisted candidate has a credential/secrets/private/token/key path.
Both top-ranked and lower-ranked secret candidates are covered in regression
tests. The command returns a structured advisory abstention rather than
treating that source as an executable or approved context.

This security change is on a **successor commit** to the original frozen
focus algorithm. Previous 22-case model/token results belong to the frozen
commit and are NOT an untouched holdout validation of the patched selector.
The feature remains read-only and Draft; no BECODER plan, BEVAL verification
or main/production promotion is implied.


## Shared sensitive source-path policy (2026-10-20 follow-up)

Automated context discovery and focus now share one conservative tracked
source-path guard (lib/context-source-policy.mjs). Prefixes including
secret_helper.py, secretHelper.py, token_helper.py, credential*, private*
and api_key* are excluded as candidates before their source text is read.
A repository containing such excluded eligible tracked Python/JS/JVM source
reports restricted_source_files_excluded and discovery.complete=false.
Auto-packing remains fail-closed; a safe focused source may be returned only
as advisory_incomplete. This avoids labeling the scan fully complete after
ignoring potentially sensitive source files.

Manual explicit BSKEL source selection, BEVAL independent verification and
the existing source-packet contract have not been loosened. This is a
conservative filename heuristic, NOT a content-level credential scanner.
Source files remain untrusted and require separate authorization to
disclose to external model providers. More restrictive projects should
avoid remote model calls entirely.


## Final read-only audit follow-up: keys paths and docstring decoys

The independent merged-PR security audit found that app/keys/handler.py
could still be emitted, and that a fake router.get decorator inside a
Python triple-quoted docstring could be mistaken for executable source.
Both patterns now fail closed.

The shared discovery/focus/slice source-path policy conservatively excludes
keys/, key/, keys.py, key_store/, keystore/ and existing private,
token and secret credential-like prefixes. The focused Python source locator
uses the discovery module comment/string mask before matching decorators
and callables; the returned excerpt remains byte-for-byte from pinned Git.
A standalone adversarial regression checks that docstring decoys are
rejected while a real handler after a docstring is retained.

The source-file policy is deliberately conservative. A path rejection is
not proof of genuine secrets. Explicit manual source selection and
sbf.context-packet/1 authority remain separate. The older frozen focus
holdout cannot be reused as unbiased evidence for this security change.
Keep Draft until the newest commit passes GitHub CI and independent review.


## Decorator ownership and full-contract route validation

The final security review also found two ways the earlier focus locator
could incorrectly announce advisory_complete: a method name decorated for
a different GET route, and an actual decorator attached to an intervening
class rather than the following target function.

The locator now requires a continuous syntactic decorator chain from a
true source decorator to the exact callable declaration. A class,
assignment, standalone string or other statement between them invalidates
the chain. A static literal GET route must match the expected full contract
path; a different literal route abstains, and a route that might depend on
an unseen router prefix is never certified as complete.

This conservative matching can reject otherwise valid FastAPI prefix
compositions, dynamic routing and unsupported syntax. Such false negatives
are preferable to confidently attaching source to the wrong route.
The source focus remains advisory. It is not Python AST execution, a
verified full API call graph, a BECODER plan, or a BEVAL signed receipt.

The five negative/positive route-ownership regression cases are stored
in test/context-focus-route-validation.test.mjs. Earlier navigation
benchmarks used prior frozen source-selector commits and must not be
recounted as a new untouched holdout for this implementation.


## Inline comment route spoofing hardening

A read-only reviewer found that a deceptive inline source comment could
introduce a fake GET route literal for a different declared path. For
example, an actual multiline decorator for /other could have a comment
containing a lookalike GET /ping and previously be marked complete for
the /ping contract.

Focused route matching now reads the comment/docstring-masked source
with genuine Python quoted route strings preserved. This does not
execute Python or trust its comments. The source excerpt returned to
the caller remains the original commit-pinned bytes. Two route-level
regressions check the fake-matching and real-matching variants.

The operation status remains advisory, and a matching literal does not
resolve route prefixes, dynamic expressions, BECODER plans, import
closure or BEVAL execution authority. Previous post-hoc benchmarks
do not certify this updated successor commit.


### Static GET route and decorator ownership gate

After an independent adversarial review, context focus was additionally
restricted to **GET** contracts and simple directly quoted GET decorator
routes. Source expressions (conditional paths, nested tuples,
concatenations, computed path values) can no longer certify an exact route
based on an incidental quoted string. A detectable nonempty local
FastAPI router prefix or Spring class-level RequestMapping downgrades
a matching method-level path to advisory_incomplete because full
controller/router composition has not been established.

A decorator stack must belong to the target callable; any intervening
class, assignment, docstring or unrelated statement breaks ownership.
Python inline comments cannot forge a route literal. The source is still
only an immutable-Git **advisory navigation hint**, never a complete
runtime routing proof, BECODER plan or BEVAL verified result. Imports,
transitive route prefixes and dynamic runtime registration require
independent verification.

The old 22-case scored set and four-case code-generation smoke were used
during development, so any compatibility rerun is **post-hoc** rather than
new unbiased evidence. A new holdout against unchanged strong baselines
is required before publishing new accuracy or token savings claims.
