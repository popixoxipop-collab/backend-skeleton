# T00-03 Lease / fencing protocol

Status: SUBMITTED  
Revision: `T00-03-R1`

This operationalizes the conceptual ownership freeze in `T00-03-OWNERSHIP.md`. It does not make the current `T00-04-PREFREEZE` final, and it authorizes no stable CLI/schema/package change.

Each claim binds task/track, repository/branch, exact base SHA, interface revision, read/write scope, worker, resource class/key, monotonically increasing fencing token, lease expiry and state.

Only `CLAIMED`/`RUNNING` claims reserve write scope. A submitted result is reviewable only if its claim exists, it carries the newest fencing token, it arrived before expiry, repository/branch/base still match, and every touched path is within the claim.

The verifier fails closed on simultaneous overlapping writes (including case-only path collisions), traversal/absolute scopes, expired active leases, fencing-token regression, stale-token results, expired results, and touched paths outside a claim.

Known scope violations remain violations rather than exceptions:
- T12 / bskel #66: live `scanners/adapters/**` registration outside Wave-A leaf ownership.
- T15 / becoder #8: package/product/renderer edits outside pre-freeze T15 `next` ownership.

Verification:
- negative/unit tests: 10 pass / 0 fail
- frozen policy + current ledger: `ok:true`
- valid T00-03 submission packet: `ok:true`

T00-03 remains SUBMITTED pending normal review/CI; T00-04 remains BLOCKED_PREFREEZE.
