package com.example.app.domain.annotationstyles.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): NOT a "fix this" fixture -- a "pin this as a known limitation" fixture
// for scanners/adapters/java-spring.mjs's regex-based (not a real parser) extraction, each case
// found by directly probing the regex during P3's own grounding. CATALOG.md's A2 ("a staged Java
// analyzer") is the item that would actually fix these; this file (and its siblings in this
// package) exist so A2 has a concrete before/after fixture to work against, and so this test
// suite has synthetic coverage of a defect class that (see test/scan-fixture.test.mjs) the real
// oracle repo never happened to exercise -- 37 controllers, 0 mismatches, purely because that
// repo's style is too uniform to ever hit them. See the sibling *Controller.java files in this
// package for the other broken shapes -- each is isolated in its own file/class deliberately: the
// mapping regex's `(?:\(([\s\S]*?)\))?` capture group backtracks across the WHOLE REST OF THE
// FILE looking for any later `)` followed by `\n\s*public`, so a broken shape placed before
// another valid method in the SAME file doesn't just get dropped -- it can get misattributed to
// that unrelated later method instead (confirmed by direct execution; a worse bug than a clean
// drop). Isolating one broken shape per file removes that confound and shows the true,
// unconfounded "no match at all" behavior of each case in isolation.
//
// Historical note left here on purpose, for the phantom-operationId case below: an early
// internal draft of this fixture used the literal string operationId = "notARealOperationId" in
// its own example prose, and that string alone was enough to appear in controller.operationIds --
// even though it was never inside a real @Operation annotation.
@RestController
@RequestMapping("/annotation-styles")
public class AnnotationStyleController {

	@Operation(summary = "A normal, correctly-detected endpoint", operationId = "normalEndpoint")
	@GetMapping("/{id}")
	public ResponseEntity<NormalResponse> normalEndpoint(@PathVariable UUID id) {
		return ResponseEntity.ok(null);
	}
}
