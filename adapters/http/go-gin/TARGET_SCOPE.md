# HTTP-go-gin-01 target scope

Status: **static source and evidence plan**, not production certification. Prerequisite T12-02 is MET. This target owns only `adapters/http/go-gin/**`.

The current Gin path is a two-stage static candidate. T08 recognizes local `gin.Default()` / `gin.New()` roots, same-file literal `Group()` assignments, and literal `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, and `Any` calls. The unregistered T12 leaf projects those `bskel.native-language/1` facts into `bskel.internal.http-wave-a-leaf/0`. Neither stage is a Go parser, type checker, Gin runtime, registered scanner adapter, packaged product path, or stable cross-tool contract.

The committed upstream source pin is `gin-gonic/examples` commit `c2f7a0b158e7c8a60336f9ca5e97a517740234dc`, path `realtime-chat`. Its exact Git blobs for `main.go` and `go.mod` are copied below `fixtures/upstream/realtime-chat/` and checked by SHA-256. That module declares Go **1.26.0** and Gin **v1.12.0**. Only those immutable source bytes and declarations are in scope; no other Go or Gin version is certified.

The upstream fixture is analyzed, not built or booted. It deterministically yields the four literal routes `/room/:roomid` for GET/POST/DELETE and `/stream/:roomid` for GET. No Go compiler, module download, HTTP request, Gin route table, middleware chain, handler behavior, or external runtime-equivalence comparison is executed. Scanner-versus-runtime equality is **NOT VERIFIED**.

Must-catch cases: exact upstream commit/blob/source hashes; deterministic same-input route facts and leaf bytes; literal root and nested group composition; seven explicit HTTP methods; `Any` preserved only as `ROUTE_METHOD_WILDCARD_UNRESOLVED`; dynamic group and route paths preserved as T08 unknowns; foreign facts rejected from supported routes; exact Go/Gin version declarations; and truthful absence of registry, package, runtime, certification, release, or MET authority.

Wrapper functions, generated registrations, cross-file router aliases, build tags, generic helper factories, middleware/auth semantics, and routes installed by runtime code are **NOT VERIFIED**. Calls outside the narrow matcher, including `Handle`, may be absent rather than diagnosed. Dynamic paths are diagnosed only when they occur on a recognized local router call. No missing route may be interpreted as proof that the runtime lacks it.

`adapters/http-wave-a/BASELINE.json` labels two inline Go strings `upstream-real`, but its own limit says they are not a comparison with a third-party repository. The profile marker `historical-pass-needs-leaf-rerun` is history, not a current pass. This target therefore uses the separately hash-pinned upstream bytes and makes no runtime claim from either label.

Execute `node --test adapters/http/go-gin/target-scope.test.mjs adapters/http/go-gin/target-scope-negative.test.mjs`, then the immutable Git-source evidence replay. Existing T08/T12 sources, nested tests, `baseline.lock.json`, ownership inputs, workflow, and CI files remain untouched and source-pinned. Any official MET credit requires exact-head CI, independent review, protected merge, merged-source replay, and a T00 one-row CAS. T19/T20 runtime authority and the global release remain BLOCKED.
