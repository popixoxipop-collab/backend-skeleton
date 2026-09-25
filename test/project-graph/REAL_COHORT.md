# T02 real-repository differential cohort

Status: **diagnostic only — not support certification**. T19 owns independent QA/certification.

The runner in `real-cohort.mjs` never clones or fetches from the network. It requires the caller to
provide an exact pinned checkout, verifies `git rev-parse HEAD`, runs the current first-party adapter
registry through legacy `runScan()`, ProjectGraph planning, and T02 shadow execution, and prints a
machine-readable result.

Observed on EOE (Darwin) on 2026-09-25:

| Case | Pinned commit | Legacy selection | ProjectGraph plan | Result |
|---|---|---|---|---|
| spring-projects/spring-petclinic | `818c4136ea971c21674525f9053de0d9c7ad8cfe` | java-spring at repo root | `.:java-spring` | pass; 30 selected read-set files |
| rtfeldman/node-express-realworld-example-app | `ba04b70c31af81ca7935096740a6e083563b3a4a` | javascript-express at repo root | `.:javascript-express` | pass; 13 selected read-set files |
| lobsters/lobsters | `69df721c9fe260c71c8af6550dafdd2783ad18b3` | ruby-rails at repo root | `.:ruby-rails` | pass; 136 selected read-set files |
| fastapi/full-stack-fastapi-template | `cb740b656d7a0a6c5e12c7bf8e50343ec94ee9c7` | python-fastapi from repo-wide recursive detection | `backend:python-fastapi` | pass; root is aggregate, frontend and react-email remain separate |

The FastAPI case is the important differential: legacy selection correctly finds the FastAPI adapter
but cannot express that the actual backend is a child project. ProjectGraph scopes the adapter to
`backend` without claiming the frontend or email package belong to that HTTP service.

Every case also verifies that serialized ProjectGraph JSON does **not** contain the absolute checkout
root. The output is bound to content hashes and project-relative paths; same-process execution may
retain a non-enumerable absolute root only as a stronger local safety check.

Example:

```bash
node test/project-graph/real-cohort.mjs spring-petclinic /path/to/pinned/spring-petclinic
```

Formal corpus admission, license review, holdout independence and support status remain T19-owned.
