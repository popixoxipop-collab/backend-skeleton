# T08-06 installed-package T19 review candidate

Marker: `DOT-T08-06-T19-INSTALLED-20261122`. Status: **CANDIDATE_OBSERVATION_NOT_APPROVAL**. This is a separate T19-owned, local review packet. It does not approve T08-06, amend PR #385, attest a private holdout, claim platform support, or authorize release. The T08 handoff still asks for 13 independent negative vectors and source-span precision/recall; this packet covers only the four independently drafted language examples below plus a golden mutation and installed-file tamper.

The exact candidate is PR #385 commit `c45eb5aefd6ca3dc787389db337f016177a03757`, tree `bd187ad9a6cb7d93f367d59ee5ee1495e6547184`, `package-lock.json` SHA-256 `c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0`. The test uses `git archive` of that commit, `npm pack` with a disposable writable cache, and `npm install` of the produced tgz into a disposable consumer. It imports `scanners/language/native-server/index.mjs` from **inside the installed package**, verifies `NATIVE_WORKER_PATH` points inside that package, and calls `runNativeServerWorker` twice per fixture. It compares all 424 archive and installed members against the exact Git blobs, including bytes and relevant modes; it checks deliberate byte and mode corruption of the installed worker. No application code is executed by the fixtures.

Run from the repository root with a new absolute output directory:

```sh
T19_T08_OUTPUT_DIR=/workspace/t19-t08-review-output node next/t19/t08-06-review/installed-review.mjs
node next/t00/check-ownership.mjs map
node next/t00/check-ownership.mjs paths --track T19 next/t19/t08-06-review/README.md next/t19/t08-06-review/installed-review.mjs next/t19/t08-06-review/golden-candidate.json next/t19/t08-06-review/fixtures/*.go next/t19/t08-06-review/fixtures/*.cs next/t19/t08-06-review/fixtures/*.rs next/t19/t08-06-review/evidence-installed/*.json
```

The script removes its temporary source checkout, npm cache, tgz, and consumer in `finally`. It does not update the T08 checkout. The output directory must not already exist. `evidence-installed/` contains the captured result of the successful run at 2026-11-21 20:12 UTC; `receipt.json` includes exact subprocess argv, exit codes, and stdout/stderr SHA-256. The top-level command exited **0**, stdout SHA-256 `c37dca23ffae6ec17ef193822d4e34732deed7b834b44777279ecab8dc1560e7`, stderr SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` on Node v24.19.0 / npm 11.9.0. The tgz SHA-256 is `598fb1cbcfd4d0e2e8842b2c120efeac2b76112a25e589b1f14450deea00dc5a`.

The archive preserves Git modes. For example `next/t11/observed-report-cli-v1.mjs` is Git/archive `0644` with bytes SHA-256 `7f677f9228e6fb21e4483af2909d7e46f93a7414198627ccf84f7d7ef54f5747`; it is a declared npm `bin`, so the installed file is `0755` with identical bytes. `handles/providers/java-spring/ast-helper/gradlew` is Git/archive/installed `0755`. The script records both `git_mode` and installed `mode` per member and permits this npm bin mode change only for declared bins. It does **not** claim byte-and-mode identity between Git and installed bytes for bins.

| Independent fixture | SHA-256 | Observed literal facts | Required unknown |
| --- | --- | --- | --- |
| `go-gin.go` | `ead6c52ea5b7f96c43d692bcab3db2598ca9fcaed80cb4516d3458f3031257a8` | `GET /metrics/live` | `GO_GIN_DYNAMIC_ROUTE_PATH` |
| `csharp-aspnet.cs` | `bf7d689bc31a0a9c02ed93f1b586bb0c64cc76d707032e27d785f8ffcb90e4c1` | `PATCH /reports/{slug}` | `CSHARP_MAPMETHODS_NEEDS_METHOD_SET` |
| `rust-axum.rs` | `bcd5e3ee603574c3c1bc85b72f335296d5d104860098f991be6a254f2a90d9e6` | `GET /healthz`, `POST /api/inbox` | `RUST_AXUM_UNSUPPORTED_BASE_CHAIN` |
| `rust-actix.rs` | `4df9f907339171e5ec5aa310b8be5f5367c6371fd196c22069d73d4318e1c909` | `PUT /v2/events` | `RUST_ACTIX_DYNAMIC_ROUTE_PATH` |

The golden candidate SHA-256 is `ce26967f467d32287cee6f1accd304da462c8783432fd7d5c1c85dd6dd6c2fc1`. A temporary copy replacing the Go expected route with `GET /metrics/fictional` was run against the same installed package. That negative run exited **1**, stdout SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, stderr SHA-256 `24da3a7ef21766778e35268b1c1e3fa36585f3abf27163ac5c4edbb212da3421`, with `go-gin.go: route facts differ`; its temporary golden, npm cache, archive, and consumer were removed. The passing script also mutated the installed worker bytes and mode and confirmed both inventory checks fail, then restored the file.

Ownership check: `node next/t00/check-ownership.mjs map` exited 0; `paths --track T19` on the first ten packet files exited 0 with `OK 10 paths belong to T19 only`. Rerun the path command above after adding this README. The T19 ownership map assigns `next/t19/**` to T19. This local packet does not provide a separate trusted reviewer signature, all requested negative vectors, false-positive/false-negative source spans, a T19 holdout attestor, or a T19 release certificate. `test/conformance-next/holdout-attestors.json` still has no keys and `evidence/next/T19-RELEASE-ACCEPTANCE.json` remains blocked. An authorized independent T19 owner must decide whether and how to use this candidate packet.
