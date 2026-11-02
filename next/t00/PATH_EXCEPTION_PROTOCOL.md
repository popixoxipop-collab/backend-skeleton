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

Limits: a digest supplied by the same untrusted actor as the receipt proves only self-consistency. The offline checker validates the shape of the GitHub approval URL and records the claimed actor; it cannot authenticate that actor or establish that the receipt came from a protected branch. The coordinator or a future GitHub-integrated gate must verify those facts independently. A PR's own modified copy of a receipt is not trusted approval. No existing CI job enforces this cross-repository receipt protocol yet.
