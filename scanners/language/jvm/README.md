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
- `semantic-backend.mjs` — an injection boundary for an explicitly approved compiler-backed
  helper. It checks request mode, exact source SHA and source-root containment before invoking the
  helper, and labels the returned coverage narrowly as record-component semantics.

The repository already contains JavaParser + Symbol Solver under
`handles/providers/java-spring/ast-helper/` and its Node bridge. T05 does not import that
downstream provider from the static scanner layer. An integration owner can inject the existing
helper into `semantic-backend.mjs` after the cross-layer dependency is approved.

## Deliberate non-support

This layer does not currently claim Kotlin parsing, compiler/build-plugin or annotation-processor
execution, Lombok-generated members, runtime bean activation, authorization enforcement, full JPA
inheritance/access-strategy semantics, OpenAPI reconciliation, Quarkus/Micronaut semantic adapters,
or a production adapter-registry switch.

The injected semantic backend is also not a claim of a complete dependency classpath: the existing
helper resolves JDK reflection plus its configured source root and may leave third-party types
unresolved. The `classpathFingerprint` binds an approved input snapshot; it does not magically
expand the helper's resolution coverage.

In particular, discovering an annotation is not the same as proving its framework behavior.
Framework semantics remain in framework-specific adapters/profiles.

## Tests

The detailed tests and Java counterexample corpus live under `test/language-jvm/`.
`test/jvm-language-foundation.test.mjs` imports them so the repository's existing
`node --test test/*.test.mjs` / `npm test` path executes T05 without changing package scripts.

Focused execution:

```bash
node --test test/jvm-language-foundation.test.mjs test/java-spring-analyzer.test.mjs
```

The corpus covers interface mappings, composed annotation cycles, generic records,
mapped-superclass inheritance, multiple top-level declarations, UTF-8 byte spans, conservative JPA
facts, Spring shadow parity, framework profile admission, and semantic-helper hash/approval gates.
