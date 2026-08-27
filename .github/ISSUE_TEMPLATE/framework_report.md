---
name: Framework/real-repo report
about: You ran bskel against your own real repo and something was wrong -- extraction, codegen, a gate, anything
title: "[framework-report] "
labels: framework-report
assignees: ''
---

<!--
This template exists because bskel's own verification confidence varies a lot by adapter --
java-spring and python-fastapi were checked against production/official-reference repos,
typescript-express against one community boilerplate, javascript-express against a synthetic
fixture only. A report against a REAL repo bskel hasn't seen before is the single most useful
thing an external user can give this project. See CATALOG.md/DECISIONS.md if you want the exact
adapter-by-adapter verification basis before filing.
-->

**Which adapter/framework** (java-spring / python-fastapi / typescript-express /
javascript-express / generic-grep):

**`bskel doctor` output** (confirms which adapter detected, and its capabilities):
```
paste here
```

**What you ran** (the exact command(s) -- `scan`, `contract emit`, `handles emit`, etc.):
```
paste here
```

**What you expected vs. what actually happened:**


**Can you share a minimal reproduction?**
A synthetic snippet of the real code shape that tripped this up is far more useful than a
description -- bskel's own fixture corpora are built exactly this way (see `test/fixtures/`).
If the real code itself can't be shared, a hand-shrunk equivalent is the next best thing.

**Anything in the output that looks like it silently produced a WRONG result** (not just an
error) -- these matter more than crashes, since a wrong-but-successful scan/contract/codegen is
much harder to notice on your own.
