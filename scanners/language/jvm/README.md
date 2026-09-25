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

The existing JavaParser + Symbol Solver helper under
`handles/providers/java-spring/ast-helper/` is reused as the candidate compiler-backed semantic
backend for later work; T05 does not duplicate or silently invoke it in static mode.

## Deliberate non-support

This layer does not currently claim Kotlin parsing, compiler/build-plugin execution,
Lombok/annotation-processor generated members, runtime bean activation, authorization enforcement,
full JPA inheritance semantics, OpenAPI reconciliation, Quarkus/Micronaut route adapters, or a
production adapter-registry switch.

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

The Java corpus covers interface mappings, composed annotation cycles, generic records,
mapped-superclass inheritance, multiple top-level declarations, UTF-8 byte spans and conservative
JPA direct facts.
