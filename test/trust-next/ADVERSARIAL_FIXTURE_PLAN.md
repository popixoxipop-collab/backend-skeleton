# T20 adversarial enforcement fixture plan

Status: pre-enforcement fixture specification. These cases are **not** claimed to be enforced yet.
Owner: T20. Runtime wiring remains BLOCKED until T00-04 freezes the shared runner/profile interface.

| Fixture ID | Attack / failure | Required T20-03 observation |
|---|---|---|
| TRUST-FS-01 | `../` traversal request | permission declaration rejects before launch |
| TRUST-FS-02 | Windows drive-absolute root | permission declaration rejects before launch |
| TRUST-FS-03 | allowed in-repo symlink points outside source root | actual runner denies/read fails; requested manifest alone is insufficient |
| TRUST-FS-04 | write through symlink into source/host path | actual runner denies and source remains byte-identical |
| TRUST-PROC-01 | execute `sh -c` / shell fragment | manifest rejects executable grant |
| TRUST-PROC-02 | allowed basename resolves to repo-controlled fake binary | runner uses pinned executable identity or rejects |
| TRUST-PROC-03 | allowed process spawns unapproved grandchild | enforcement denies/kills descendant and records failure |
| TRUST-ENV-01 | ambient provider/database token exists but is not allowed | child environment does not contain it |
| TRUST-ENV-02 | request `NODE_OPTIONS` / `PYTHONPATH` / `RUBYOPT` | manifest rejects |
| TRUST-ENV-03 | allowed env value contains NUL/non-string | environment selection rejects |
| TRUST-NET-01 | outbound network with default-deny | connection fails independent of application cooperation |
| TRUST-NET-02 | allowed public host redirects/resolves to loopback/private IP | runner does not widen destination implicitly |
| TRUST-NET-03 | attempt Unix socket / Docker socket access | denied unless a distinct future socket/device permission exists |
| TRUST-OUT-01 | stdout/stderr flood | output is bounded/truncated with explicit diagnostic; runner remains healthy |
| TRUST-TIME-01 | child ignores termination / hangs | wall limit kills full process tree and cleanup is verified |
| TRUST-SECRET-01 | secret ref name uses path traversal | manifest rejects |
| TRUST-SECRET-02 | unrelated secret ref requested | resolver refuses; no fallback to ambient environment |
| TRUST-ADAPTER-01 | user supplies external JS adapter path | no dynamic import through the first-party registry |
| TRUST-BUILD-01 | package install hook attempts network/file exfiltration | acquisition/build profiles remain separate; untrusted build does not receive credentials |
| TRUST-EVID-01 | requested manifest differs from actual enforced profile | evidence records effective profile and mismatch blocks certification |

## Test structure

Each runnable fixture will have:
1. exact source/input bytes and hash;
2. requested permission manifest;
3. effective runner profile revision/digest;
4. expected allow/deny outcome;
5. external observer assertion (file bytes, socket listener, environment capture, process tree, or network probe);
6. cleanup assertion;
7. raw artifact/evidence hashes.

Candidate self-report such as `{"blocked":true}` is never sufficient. Denial must be externally observable at the runner/host boundary.

## Platform matrix

The first enforcement slice should prove one hardened Linux/container profile before claiming cross-platform parity. macOS/Windows may use different mechanisms and must receive separate certification. Lack of a mechanism is `BLOCKED`, not a silent fallback to in-process policy checks.
