// T05 JVM foundation tests live in a nested directory so their fixtures can stay colocated.
// The repository's existing npm test command uses test/*.test.mjs, therefore this one top-level
// file is the only integration hook needed to make the full CI suite execute the T05 tests.
import './language-jvm/jvm-foundation.test.mjs';
import './language-jvm/jvm-annotation-graph.test.mjs';
import './language-jvm/jvm-member-facts.test.mjs';
import './language-jvm/jvm-spring-shadow.test.mjs';
import './language-jvm/jvm-framework-profiles.test.mjs';
import './language-jvm/jvm-semantic-backend.test.mjs';
