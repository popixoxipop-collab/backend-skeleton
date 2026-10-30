# T18-04 adversarial scope — shadow protocol intake

This is an executable **static contract** matrix for the existing T18 shadow
importers. It is not a protocol-runtime, broker, server, resolver, authorization,
or release certificate.

`test/protocol-next/t18-adversarial-matrix.test.mjs` exercises:

- gRPC `.proto`, GraphQL SDL, AsyncAPI YAML, and explicit WebSocket manifest
  source mutations. Each changed declaration must change the source identity;
  no scan gains a runtime or certification claim.
- Comment decoys for gRPC and GraphQL; remote `$ref`, byte-budget, and duplicate
  YAML-key failures; and an unbound WebSocket message that stays blocked.
- AsyncAPI 2.6.0 and 3.0.0 structural dialects. A changed 3.0.x version label
  changes the source hash but does not prove broker or client compatibility.
- Exact protocol-contract bytes, typed item identity, and family mismatch.
- Node permission mode: bounded loader execution while an unrelated corpus read,
  a write-capable open, and child-process creation are denied. This is a Node
  file/child-process boundary test, **not a network sandbox** or a confinement
  claim for arbitrary target code.

The T19 `test/corpus-next/negative-vectors.json` manifest is a committed,
exactly 79-vector certification input. It has no `protocol` category. T18 does
not append to or reclassify it; doing so would change T19 authority and its
certification hash. The T18-local executable matrix closes only the owned
shadow-importer test slice. A protocol category in a future T19 corpus revision,
independent T19 review, real gRPC/GraphQL/broker/WebSocket execution, T16 oracle
results, signed attestation, and promotion remain separate work.

The GitHub Node 22/24 CI lanes and Bob's independent exact-merge replay are
required to claim cross-Node-version replay. The AsyncAPI dialect comparison
is source-structure coverage, not a real broker-version run. A green local test
without those later gates cannot award T18-04 MET.
