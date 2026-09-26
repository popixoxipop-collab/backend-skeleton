# T19 independent review — T18 protocol-next post-04B

Status: **PASS for static protocol-contract / package-shadow scope only**

Target:
- PR: #132
- exact head: `29bdb7347967b0c5adf7faa3ec6a586d31e1483a`
- base: `1b8851f2abb426fce5682b39450ffaeae7e266ac`
- exact-head CI: #1171 / run `36140757181` = **SUCCESS**
- changed files: exactly 22, confined to `adapters/protocol-next/**` and `test/protocol-next/**`

## Focused execution evidence

Required post-04B nested lane executed the T18 suite rather than reporting NOT_PRESENT:

- Node 22 job `108089727271`: `NESTED_SUITE T18 RUN 6 files`, 69 tests, 69 pass, 0 fail.
- Node 24 job `108089727489`: `NESTED_SUITE T18 RUN 6 files`, job conclusion SUCCESS.
- package-install job `108089727259`: SUCCESS, proving the approved `adapters/protocol-next/` package-shadow path survives real npm pack/install.

All other required CI jobs completed successfully. The macOS and Spring canary jobs were skipped by their existing event policy.

## Independent semantic review

Reviewed exact target blobs include:

- `adapters/protocol-next/contracts/protocol-oracle-request.mjs` = `05bcda0830e918ed0527e9c3266c7d1433a2dc19`
- `adapters/protocol-next/scanners/protocol.mjs` = `9b78fd4c96bdeb390f7ad32c03ff9128247f1404`
- `test/protocol-next/protocol-conformance.test.mjs` = `f5bd9f4f4c8c78b896e5fc5625a9f7b8efb64262`
- `adapters/protocol-next/docs/T18_TO_T16_PROTOCOL_ORACLE_HANDOFF.md` = `0203b7499d6327edd021346369db88ce16ff1fef`

Findings:

1. Oracle request semantics explicitly state:
   - request is not runtime evidence;
   - ordering does not imply causation;
   - correlation does not imply causation;
   - executor must re-hash referenced bytes;
   - executor must independently verify protocol item existence.
2. Static importers preserve partial/blocked completeness and warnings instead of promoting declaration presence into runtime behavior.
3. The conformance corpus explicitly labels itself non-runtime certification.
4. The T18→T16 handoff keeps runtime execution, immutable RunBinding, independent probes, provider-failure separation and replay protection owned by T16/beval.
5. T18 only adds its isolated next-plane adapter/test namespaces; no live production registry is changed.
6. The package allowlist exposes protocol-next as package-shadow only; package presence is not runtime certification or activation.

## Boundary

This PASS does **not** certify:
- message delivery;
- resolver/server execution;
- ordering/causality;
- runtime idempotency/timeout behavior;
- broker/socket state;
- production protocol support.

Those claims remain gated by T16/beval and subsequent promotion review.

## Verdict

**PASS** for the 04B-defined T18 static protocol-contract / package-shadow slice.

Do not reinterpret this review as runtime-tested or production-registered support.
