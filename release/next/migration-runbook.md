# T23 release / migration runbook — integrated-main rebaseline

Status: **REBASELINED_BLOCKED**.

## Invariants

1. Existing HTTP `sbf.contract-ref/1`, `sbf.action-ref/1`, and `sbf.field-ref/1` remain authoritative.
2. T01 next identity is additive; completing T01-06 does not itself flip the default writer.
3. New readers land before any next writer.
4. Packed artifacts, not source-only checkouts, are the release proof surface.
5. Historical contract/evidence bytes are never rewritten to make a new gate pass.
6. Runtime-tested claims require verifier-produced T16/beval evidence.
7. Release/default changes require a fresh scoped lease separate from this release-control rebaseline.

## Stages

- **M1 consumer-first**: old writer, legacy + next readers. This is the only stage currently being closed.
- **M2 shadow**: legacy writer plus isolated shadow-next artifacts.
- **M3 opt-in writer**: next writer only for an explicitly approved profile/package matrix.
- **M4 per-profile default**: only after profile certification, rollback rehearsal, T19/T20 acceptance, and final exact-head release CI.

## Current blockers

See `release-plan.json`. In particular, zero-file-delta merge-tree equivalence is accepted for T-series integration closeout but is **not** treated as a substitute for direct final-main release CI.

Rollback remains feature-off/read-only/old-reader first; destructive down migrations and historical evidence deletion are prohibited.
