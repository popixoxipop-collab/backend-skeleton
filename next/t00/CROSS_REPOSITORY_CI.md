# Strict three-repository CI precondition

This optional T00 command composes the byte-pinned inventory alignment check
with the existing release-policy online verifier. It always checks `bskel`,
`becoder`, and `beval`, in that order. It has no offline-success mode, role
selection, drift allowance, automatic re-pin, or write operation.

```sh
node next/t00/verify-cross-repo-ci.mjs --inventory-sha256 <independent-sha256> \
  <lock.json> <observation.json> <inventory.json>
```

Inputs are explicit bounded regular files, with the same duplicate-member,
UTF-8 and symlink checks as the alignment command. All three CI run IDs must
be positive safe integers. Every CI head must equal its aligned baseline head.
The entire preflight completes before any request. A zero-delta merge-tree
equivalence is not accepted instead of an exact-head run in this command.

The existing GitHub transport makes read-only run requests, with bounded
attempts and timeouts, using an already authorized GH_TOKEN or GITHUB_TOKEN if
provided by the caller's environment. No credentials are saved, requested, or
created. It checks repository identity, run ID, push event, main branch, exact
head, completed status and success conclusion. A private-repository 404 remains
ambiguous between missing and inaccessible; it never counts as success.
Any missing, failed, mismatched or unreadable role fails the overall check.

Exit 0 means this narrow check passed; 2 means evidence did not verify; 1 means
usage or input/transport setup failed. The JSON names every role and returns
`met_awarded=false` and `release_authorized=false`, including on success.

This command does not establish current-main freshness, freeze approval,
independent attestation, required job coverage, protected merge enforcement,
signatures or release permission. Caller-injected mock transports are test
doubles, not live GitHub evidence. Synthetic positive fixtures are not a new
accepted inventory. The actual committed inventory remains historical and
fails alignment with the recorded baseline.

The existing release workflow still selects only bskel. This change does not
modify that workflow, grant cross-repository access or bypass its restrictions.
Authorized integration of this stricter check and a legitimate frozen inventory
are separate adoption requirements. Existing release/next files are unchanged.

The regression suite lives at next/t00/cross-repo-ci.test.mjs and is imported
by the existing root T00 baseline test, so root npm test discovers it without
changing package scripts or workflow files. Regression transport replies are
synthetic; the permission test separately checks whether mode 000 causes real
EACCES and reports a skip if the execution identity bypasses permissions.
