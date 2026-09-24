# Embodiment contract v0.1

This extension compiles a robot/body specification into the existing `sbf_contract: "9"` feature-contract shape. Existing `sbf.contract-ref/1` and `sbf.action-ref/1` therefore remain the cross-tool identity.

Domain verbs are `OBSERVE`, `SKILL`, and `CANCEL`. The operation `path` is a domain resource or skill identifier, not an HTTP URL. OpenAPI export is not valid for `source.adapter = robot-embodiment`.

v0.1 is simulation-only. It requires `body.simulation_only=true`; real-hardware enablement needs a separately approved runtime/safety profile.

The first SH5 contract exposes only `sh5.can_color_sort.v1`, because that is the capability already supported by existing closed-loop smoke evidence. `can_to_box` stays absent until its own policy and evaluation exist.
