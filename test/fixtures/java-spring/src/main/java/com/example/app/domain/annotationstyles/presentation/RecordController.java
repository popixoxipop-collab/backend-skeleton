package com.example.app.domain.annotationstyles.presentation;

import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// A2 Phase 1 (D-java-analyzer): a `record` controller, not a `class` -- unusual in practice (a
// record's implicit final fields/canonical constructor aren't useful for a stateless
// @RestController), but legal Java/Spring: a record can implement interfaces, be annotated, and
// declare additional methods in its body. The old scanner's className regex only ever matched
// `public\s+class\s+(\w+)`, so a record-declared controller wasn't recognized as a controller at
// all. See AnnotationStyleController's file comment for the fixture-isolation convention.
@RestController
@RequestMapping("/record-style")
public record RecordController() {

	@Operation(summary = "Fixed (A2 Phase 1): the controller is a record, not a class", operationId = "recordStyle")
	@GetMapping
	public ResponseEntity<Void> recordStyle() {
		return ResponseEntity.ok(null);
	}
}
