# T22 → T03 change request: capability/support state contract

## Current T22 model

The SDK explanation layer uses display/evidence states:

- supported
- partial
- unsupported
- unknown
- not-applicable
- conflict

This does **not** modify the current first-party adapter descriptor's four boolean capabilities.

## T03 decision requested

Define the stable product-level capability predicate shape that can express:

- capability name
- state
- applicable version/profile conditions
- evidence requirements and references
- constraints / missing prerequisites
- conflict or unknown reasons

and publish golden vectors for it.

## Compatibility requirement

Do not silently reinterpret current `sbf.adapter/2` booleans. A bridge must state exactly how
`true`, `false`, absent, OpenAPI satisfiers and provider-specific requirements map into the new
predicate model.

## T22 follow-up

Once T03 freezes that structure, T22 will replace its local explanation input shape with a
projection from the shared predicate/claim contract while preserving:

- unknown != unsupported
- detection confidence != runtime proof
- conflict candidates/provenance
- next-action diagnostics
- SARIF projection as a consumer-only view

T22 will not make the shared vocabulary stable unilaterally.
