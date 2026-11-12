# HTTP-ruby-rails-01 target scope

Status: **static fixture and evidence plan**, not production certification. Prerequisite T11-02 is MET. This target owns only `adapters/http/ruby-rails/**`.

The default Ruby Rails scan is static, using Gemfile/railties, config/application.rb and config/routes.rb for detection. The fixture demonstrates namespace/resources/resource, member and collection paths, controller attribution, synthesized operation IDs, and explicitly assigned ActiveRecord table and primary key. Dynamically interpolated routes and unsupported DSL forms remain noted as unknown, not silently promoted.

The existing Rails integration matrix uses exact Rails **8.0.5.1** and **8.1.3.1** on generated applications. The fixture Gemfile `~> 8.1` is not an exact runtime pin. This matrix does not certify other Rails versions or external repositories. Optional `--runtime-routes` boots a target Rails application and is intentionally separated from static scanning; do not use it on untrusted projects without separate authorization.

The oracle manifest pins Discourse, Forem and Mastodon at 40-character Git commits with topic/article/account terms, respectively. The T07 corpus observations state `runtime_route_equivalence_verified=false`. Network-heavy `npm run test:oracle-corpus` is diagnostic rather than a default CI gate. External production runtime equivalence remains **BLOCKED / NOT VERIFIED**.

Must-catch cases: deterministic same-input report; literal 8-article-route expansion and explicit model identity; synthesized operationId provenance; unsupported DSL and dynamic interpolation notes; `scope path: nil` and scoped parameter literals; runtime Ruby conditions treated as unknown; fixed real-oracle revisions; Rails version pins and truthful runtime limits.

Execute `node --test adapters/http/ruby-rails/target-scope.test.mjs`, a separate negative evidence test, and immutable Git-source evidence replay. Original T07/T11/T19 and CI-owned files stay untouched. Later T11 adapter integration and T19/T16 independent runtime certification remain separate. Any official MET credit requires exact-head CI, Codex review, protected merge, merged-source replay and a T00 one-row CAS; global release remains BLOCKED.
