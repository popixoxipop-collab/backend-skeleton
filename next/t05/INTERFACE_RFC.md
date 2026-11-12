# T05-02 JVM common interface RFC

Status: T05-internal source-bound 0-draft documentation, not T01 stable SBF, runtime or release certification.

## API and identity

validateJvmAnalysisRequest accepts Java-only request schema sbf.jvm.analysis-request/0-draft, integer languageLevel 8..25, mode syntax/semantic, allowTargetExecution=false, repository-relative source roots and files with SHA-256. Validation does not read source or authorize a helper.

analyzeJavaSyntax produces sbf.jvm.syntax-facts/0-draft with path, packageName, imports, topLevelTypes and diagnostics. UTF-8 byte offsets are derived from provided source bytes; path is a caller label unless checked separately. The lexical collector is not a complete Java parser or compiler: no syntaxValidated or classpath completeness claim.

buildJvmProjectIndex, resolveJvmAnnotationName and buildJvmAnnotationGraph return local symbols, explicit resolved/unknown/conflict names, duplicate diagnostics and bounded cycle/partial traversal. A qualified spelling is not proof of runtime classpath membership.

analyzeJavaMemberFacts, analyzeJavaMethodFacts and analyzeJvmJpaDirectFacts return directly written declarations; inherited, generated and annotation-processor semantics are not inferred. Spring shadow results are diagnostic comparisons only.

assessJvmFrameworkProfile distinguishes facts-ready/incomplete/blocked; even facts-ready leaves semanticAdapterImplemented and runtimeVerified false. Kotlin/Ktor is blocked; Quarkus and Micronaut are profile-only.

createJvmSemanticRecordBackend can reach classify only after actual repository source/hash containment, launcher identity and T20 trust plus T16 runtime/evidence proof checks. Boolean-only authorization and target Java execution are refused; this is not an OS sandbox.

## Boundaries

T05 owns the JVM language facts; T01 owns cross-tool contracts; T16/T20 own helper admission; T11 owns HTTP consumers; T19 owns independent QA; T00/T23 own integration and release. Unknown or partial results must never be promoted to supported runtime behavior. The original T05-01 BASELINE.json is immutable.

## Acceptance

Use direct normal and negative JVM fixtures, source-pinned SHA-256 Git blobs, exact Node command/exit/TAP counts and adversarial replay. Production registration, Kotlin/Ktor support, T01 contract freeze, signed independent review and release remain unproven. A distinct protected-main merge and official T00 CAS are required for any scoped MET award.
