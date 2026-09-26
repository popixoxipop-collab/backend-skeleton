# JVM language analysis — T05 foundation

Status: **draft language layer, not wired into the production adapter registry**.

T05 adds a JVM/Java analysis boundary without changing the current `java-spring` scan result.
The contract/tool-wide identity model remains owned by the shared contract track; all schemas here
are deliberately `0-draft`.

## Implemented slices

- `protocol.mjs` — request/facts validation. Static analysis requires repository-relative inputs
  and always refuses target-code execution. Semantic mode requires an explicit classpath fingerprint.
- `java-syntax-facts.mjs` — dependency-free lexical/structural facts for package/imports,
  top-level class/record/interface/enum/annotation declarations, raw inheritance clauses,
  annotations, record headers and UTF-8 byte spans.
- `annotation-graph.mjs` — conservative annotation-name resolution plus bounded composed-annotation
  graph traversal. Duplicate FQNs, cycles and insufficient evidence stay explicit.
- `member-facts.mjs` — directly declared fields and record components only. It does not infer
  inherited members, generated code, JPA access strategy or validation semantics.
- `jpa-direct-facts.mjs` — directly written JPA annotations and directly proven `@Id` /
  `@EmbeddedId` members. Inherited primary keys are deliberately marked `not-evaluated`.
- `method-facts.mjs` — directly declared Java methods and their annotations/signatures, without
  HTTP/framework interpretation.
- `spring-shadow.mjs` — read-only comparison between the existing Spring structural analyzer and
  the new JVM facts for declarations, class mappings, direct method mappings and Data REST
  repository interfaces. A mismatch is evidence only; it never rewrites production scan output.
- `framework-profiles.mjs` — extension requirements for Spring Java, Quarkus/JAX-RS Java and
  Micronaut Java. Ktor is explicitly blocked because the current T05 protocol is Java-only.
- `semantic-backend.mjs` — a dependency boundary for an approved compiler-backed helper. It
  performs request/source/root/hash checks first, then requires a T20 helper/trust verification
  proof and a T16 effective runtime/evidence verification proof before `classify()` may run.

## Helper authorization boundary

A legacy boolean such as `approvedHelperExecution:true` is not an execution authorization.

The caller must supply:
- T20 `bskel.first-party-helper-requirements/1` data for a `compiler-helper` using
  `approved-files`, with target-code execution forbidden and runtime/evidence still required;
- matching T20 `bskel.trust-evidence-echo/1` enforcement data;
- T16 `beval.runtime-binding/1` plus its exact binding hash;
- T16 `beval.runtime-evidence-pair/1` bound to the same attempt;
- a non-executing observed launcher basename/SHA-256 identity;
- injected T20 and T16 verifier functions that return concrete identity proofs, not a boolean.

T05 does not reimplement the T20 permission/trust evaluator or the T16 runtime/evidence verifier.
Those owners validate their own semantics. T05 checks that the returned proof identities match the
exact helper requirements and runtime/evidence documents supplied to this execution request.

Before any helper execution callback is reached, T05 rejects:
- missing authorization;
- source SHA drift;
- a file outside all declared source roots;
- lexical or realpath repository escape;
- symlink escape;
- launcher basename/SHA mismatch;
- mismatched T20 trust evidence;
- mismatched T16 binding/evidence identity.

The repository already contains JavaParser + Symbol Solver under
`handles/providers/java-spring/ast-helper/` and its Node bridge. T05 does not import that
downstream provider from the static scanner layer and does not duplicate it. A T16/T20 integration
owner may inject the existing helper only through the authorization boundary above.

## Static-path guarantee

The static JVM modules do not import `node:child_process` and do not import the existing
`handles/providers/java-spring/**` implementation. A syntax-mode request is rejected before the
semantic backend reaches executable inspection, T20/T16 verification callbacks, or `classify()`.

This is a code-level static/unit boundary, not an OS sandbox claim.

## Deliberate non-support

This layer does not currently claim Kotlin parsing, Ktor semantic support, compiler/build-plugin or
annotation-processor execution, Lombok-generated members, runtime bean activation, authorization
enforcement, full JPA inheritance/access-strategy semantics, OpenAPI reconciliation,
Quarkus/Micronaut semantic adapters, or a production adapter-registry switch.

The injected semantic backend is also not a claim of a complete dependency classpath: the existing
helper resolves JDK reflection plus its configured source root and may leave third-party types
unresolved. The `classpathFingerprint` binds an approved input snapshot; it does not expand the
helper's resolution coverage.

## Tests

The owned tests and Java counterexample corpus live under `test/language-jvm/**`.
T05 executes those nested tests explicitly; shared root-test discovery remains T00/T23-owned.

Focused execution:

```bash
node --test test/language-jvm/*.test.mjs test/java-spring-analyzer.test.mjs
```

The corpus covers interface mappings, composed annotation cycles, generic records,
mapped-superclass inheritance, multiple top-level declarations, UTF-8 byte spans, conservative JPA
facts, Spring shadow parity, framework-profile admission, and the T20/T16 helper-authorization
boundary.
