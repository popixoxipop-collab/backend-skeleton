# JVM language analysis — T05 foundation

Status: **draft, not wired into the adapter registry**.

This directory starts T05 without changing the existing `java-spring` adapter. The first slice has
one job: provide a deterministic, target-code-free Java syntax boundary that later Spring,
Quarkus, Micronaut and Ktor work can consume after the shared interface is frozen.

## Boundary

- `protocol.mjs` defines draft request/facts validation. It deliberately refuses target execution.
- `java-syntax-facts.mjs` is a dependency-free lexer-level analyzer. It extracts package/imports
  and top-level type declarations, preserving annotations, raw headers, inheritance clauses,
  record components and UTF-8 byte spans.
- It does **not** resolve types, annotation semantics, meta-annotations, Spring routes, JPA fields,
  Lombok-generated members, Kotlin, compiler plugins or build outputs.
- Semantic resolution remains a later T05 step. The existing JavaParser/Symbol-Solver helper under
  `handles/providers/java-spring/ast-helper/` is an input to that design, not silently imported here.

`0-draft` is local to this T05 branch. It must not be treated as an `sbf.adapter/2` replacement or
as a stable cross-repository contract until the contract owner approves the common interface.

## Tests

The T05 tests intentionally live under `test/language-jvm/` and are run directly while this work is
isolated:

```bash
node --test test/language-jvm/jvm-foundation.test.mjs
```

CI/package-script wiring is an integration-owner change, not part of this leaf task.
