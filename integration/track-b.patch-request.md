# Track B integration patch requests

Track B deliberately does not edit shared hot files. The runtime implementation on this branch is usable as modules, but the following integration changes are required before release.

## PATCH-B-01 — package surface
Target: `package.json`, `package-lock.json`

Reason:
- npm package `files` currently includes `gameplay/` but not `webgame/`.
- the real browser driver dynamically imports Playwright, but Playwright is not currently declared.
- the owned no-dependency canvas fixture proves build/serve lifecycle; the planned Three.js acceptance fixture still needs a project-approved local Three.js dependency rather than external CDN access.

Required changes:
- add `webgame/` to the package files allowlist.
- add the project-approved Playwright dependency and lockfile entry.
- add the project-approved Three.js test/dev dependency if the Integration Wave requires the owned fixture to be a literal Three.js renderer.
- do not allow browser downloads or CDN fetches during runtime verification without an explicit integration policy.

Compatibility:
- existing gameplay provider registry remains unchanged.
- no existing scanner capability is promoted by this patch.

Tests:
- package-install smoke can import `webgame/contract.mjs`, `webgame/playwright-driver.mjs`, and `webgame/runtime-runner.mjs`.
- a clean install can launch the approved Playwright Chromium revision.

## PATCH-B-02 — Foundation schemas
Target:
- `schemas/webgame-runtime.schema.json`
- `schemas/webgame-execution-plan.schema.json`
- `schemas/webgame-probe.schema.json`

Reason:
Foundation owns shared schema files. Track B currently performs fail-closed semantic validation in code and intentionally did not invent competing shared schemas.

Required contract:
- runtime contract must not grant itself execution authority.
- source trust is declarative only.
- execution approval is supplied out of band and must match `project_id` and `source_root`.
- loopback-only serve URL.
- browser worker requirements are optional but validated when declared.
- probe sequence/time/frame are monotonic.

Tests:
- valid/invalid schema fixtures agree with `webgame/semantic-validation.mjs`.
- schema validation never turns `reference` into executable.

## PATCH-B-03 — CLI wiring
Target: `bin/bskel.mjs`, `lib/cli.mjs`

Suggested command:
`bskel webgame verify --contract <file> --approval-profile <id> [--json]`

Required flow:
1. read + schema validate one runtime contract
2. semantic validate
3. resolve approval from an external trusted profile/registry
4. build side-effect-free execution plan
5. capability check
6. run owned build + loopback server + isolated browser
7. emit `sbf.webgame-runtime-result/1` as ungated runtime evidence

Safety:
- no contract field may substitute for `--approval-profile`.
- reference repositories remain inventory-only.
- do not add arbitrary shell command parsing; argv arrays only.
- external network remains blocked by default.

## PATCH-B-04 — provider/registry integration
Target: shared provider/registry files only during Integration Wave 1.

Reason:
Dropping a Three.js browser provider directly into the existing auto-discovered gameplay provider directory would change current registry expectations while Track A/C are parallel.

Required behavior:
- register only after shared capability names and provider schema are frozen.
- preserve existing Unreal provider semantics.
- runtime verification capability must not imply code generation.

## PATCH-B-05 — real browser acceptance
After PATCH-B-01 is installed, run the owned fixture through the real Playwright driver, not the injected fake driver.

Required negative coverage:
- missing probe / blank runtime
- main-document 404
- page JavaScript exception
- failed local asset request / decode error surfaced as browser health failure
- required worker timeout
- ignored input / camera-only motion
- vertical fall
- teleport-sized step
- wall crossing
- interaction double-fire
- page crash

Completion evidence:
- Chromium run result stored as ungated runtime evidence.
- no owned server/browser process or bound port remains after success, failure, or timeout.
