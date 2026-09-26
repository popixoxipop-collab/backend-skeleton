# T20 security closeout evaluator

This is a fail-closed **readiness evaluator**, not a release command and not evidence generation.

T20 closeout requires all of the following at one exact product revision:

1. exact effective runtime/profile implementation digests plus external evidence refs;
2. T20 requested/effective trust requirements match and both are marked enforced;
3. all admitted T20 runner/evidence adversarial cases pass with the declared external observer and evidence refs;
4. artifact trust policy signature verifies with the explicitly supplied trusted key and minimum generation;
5. secret scan has zero leaks;
6. cleanup has zero orphan resources;
7. downgrade rehearsal proves:
   - revoked artifact denied;
   - permission expansion denied;
   - trust generation rollback denied;
8. no non-waivable blocker remains.

The evaluator intentionally does not inspect GitHub CI, merge status, package shipping, support certification or release approval. Those remain T19/T23/T00 responsibilities.

A unit test can construct synthetic all-green inputs to prove evaluator logic. Such a test is not product security evidence. The current T20 branch cannot produce a real ready closeout until T20-03 effective runtime enforcement and external adversarial evidence exist.
