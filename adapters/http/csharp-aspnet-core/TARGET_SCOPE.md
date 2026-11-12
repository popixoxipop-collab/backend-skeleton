# HTTP-csharp-aspnet-core-01 target scope

This target is a static-fixture and source-bound evidence candidate for the
existing T12 ASP.NET Core projection. It depends on the T08 C# native-server
facts already admitted by T12-02. This change owns only
`adapters/http/csharp-aspnet-core/**`; it does not edit the T08 analyzer, the
T12 projection, T00 inputs, shared CI, package metadata, the baseline lock, or
the nested-test runner.

## Supported static surface

- Literal Minimal API `MapGroup` chains rooted at `app`, followed by literal
  `MapGet`, `MapPost`, `MapPut`, `MapPatch`, or `MapDelete` routes.
- Direct controller `[Route]` plus `[HttpGet]`, `[HttpPost]`, `[HttpPut]`,
  `[HttpPatch]`, `[HttpDelete]`, `[HttpHead]`, or `[HttpOptions]` attributes
  whose route arguments are string literals.
- `[controller]` and `[action]` token substitution performed by the T08
  static analyzer.
- Projection of those T08 facts into the existing unregistered T12 candidate
  leaf without operation-id synthesis.

This is not Roslyn, compiler, Kestrel, model-binding, ApiExplorer, endpoint
filter, authorization, generated-code, or inherited-metadata authority.

## Frozen external identity and oracle boundary

- Repository: `dotnet/AspNetCore.Docs`
- Path: `aspnetcore/tutorials/min-web-api/samples/8.x/todoDTO`
- Commit: `5f20cce1736b24cb468c98833d965e969613bc3f`
- Declared sample framework: `net8.0 sample`

The commit and path are exact; no floating branch, tag, package version, SDK
range, or ASP.NET runtime range is claimed. The bounded local run does not
acquire that upstream checkout and does not invoke `dotnet`, Roslyn, or
Kestrel. Therefore `realRepoComparison` is `BLOCKED_INFRA`, and equivalence to
the external sample or any installed runtime is **not verified**.

## Must-catch matrix

The local proof must catch all of the following without inventing authority:

1. Nested literal Minimal API groups and explicit supported methods.
2. Literal controller/action templates and `[controller]`/`[action]` tokens.
3. The exact upstream repository, path, commit, and sample-framework label.
4. Dynamic `MapGroup` and `Map*` paths as unknown diagnostics.
5. `MapMethods` as unresolved because its method array is not parsed.
6. Conventional controller routing and dynamic route attributes as unknown.
7. Route-like text in comments and string literals as non-routes.
8. Wrong protocol/language messages and foreign T08 route facts.
9. Unsupported HTTP methods and non-absolute projected paths failing closed.
10. The leaf remaining unregistered, non-default, non-runtime-tested, and
    `NOT_REVIEWED` by T19.
11. No synthesized `operationId`.
12. Unchanged T00 ownership, `baseline.lock.json`, and
    `scripts/run-next-nested-tests.mjs` boundaries, all hash-pinned by the
    source-bound receipt.

## Authority limit

Passing these tests creates no MET, release, runtime certification, external
runtime equality, or signed-attestation claim. Official promotion still needs
review, CI, merge, post-merge replay, and the coordinator's ledger/CAS gates.
The global release remains blocked outside this candidate's scope.
