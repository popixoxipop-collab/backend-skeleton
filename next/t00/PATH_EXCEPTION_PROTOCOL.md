# T00 exact-head path exception protocol

The ownership map remains strict: a track does not gain ownership of shared hot or stable/unowned files. A T00 coordinator can instead publish a *single exact-head* receipt for a named repository, track, base, head, and each exceptional path. The verifier checks the actual Git diff, the map's classification, receipt completeness, and the independently supplied SHA-256 pin. It never changes the map or grants a lease.

For a future PR:

1. Run `check-ownership.mjs paths --track <Tnn> --repository <role> --git-diff <base> <head>` and preserve its findings. Do not describe exit 2 as a pass.
2. The T00 coordinator decides each `PATH_RESERVED_HOT` or `PATH_UNOWNED` edit, records the actor and a direct GitHub issue/PR comment URL, then commits an exact-head receipt under `next/t00/receipts/` on the protected T00 branch. A path owned by another track, a case mismatch, or an invalid name is not eligible for this receipt type.
3. Take the receipt bytes and SHA-256 from that trusted T00 revision, independently of the candidate branch. Run the command below against the candidate's actual Git objects. A new candidate head or changed path requires a new receipt and pin; there is no wildcard, branch-name, or time-based approval.
4. Keep CI, independent review, merge, and merged-tree replay as separate gates. This verifier is path authorization evidence only, not a release or MET decision.

```sh
node next/t00/check-path-exception.mjs \
  --repo-dir <candidate-checkout> --repository becoder --track T15 \
  --base <40-hex-base> --head <40-hex-reviewed-head> \
  --receipt <trusted-T00-receipt.json> --receipt-sha256 <64-hex-sha256>
```

The historical T15-03 PR #22 receipt is `receipts/T15-03-becoder-PR22.json` (SHA-256 `7897042b43861e1ec1c901292ebd3b19ed14f935268ebed90e3288083ffdbf90`). It accepts exactly five shared paths in a twelve-path diff. This is an audit example, not reusable authority for another head.

The online PR gate uses a separate `pull_request_target` workflow on the private repository. It checks out backend-skeleton `main` as trusted policy, treats the candidate checkout only as Git data, and never runs candidate code. The PR body must contain exactly one `T00-Track: Tnn` line. If the ownership map reports exceptional paths, it must also contain `T00-Receipt: <filename>.json`. The filename only selects a receipt: the gate reads its bytes and SHA-256 pin from `next/t00/receipts/index.json` in trusted T00 main, never from the PR. A successful owned-path-only diff needs no receipt.

New online receipts use `bskel.t00-path-exception/2` with the same target and exceptions fields as v1. The `approval` object must contain `login: "popixoxipop-collab"`, a direct BSKEL issue comment `url`, and `body_sha256` of the complete GitHub comment body. The coordinator comment must have a standalone `T00-Path-Exception: <digest>` line, where `<digest>` is SHA-256 of the UTF-8 JSON serialization of `{repository,track,base,head,exceptions:[{path,code},...]}` in that property order. The gate fetches the comment from GitHub, checks its actual author and issue URL, verifies the body hash and exact-target marker, and fails closed if the API is unavailable or the comment was edited/deleted. A new head, path set, or approval body requires a new receipt and index pin. The historical PR #22 v1 receipt stays an offline audit example and is deliberately rejected by the online gate.

The online gate reports path authorization only. It is not independent code review, merged-tree replay, release authorization, or an official MET decision. On the current private-repository plan, GitHub rejects branch-protection/ruleset API calls with 403; therefore the new status cannot truthfully be called a mandatory merge block until repository governance supports and requires it. A PR author with write access can still alter their repository workflow in a subsequent merge; this is why the gate's own workflow must remain on base `main` and never execute candidate code.
