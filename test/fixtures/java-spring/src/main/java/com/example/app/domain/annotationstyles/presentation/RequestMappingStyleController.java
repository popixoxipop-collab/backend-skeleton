package com.example.app.domain.annotationstyles.presentation;

import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): a known scanner limitation, isolated in its own file -- see
// AnnotationStyleController's file comment for why. Method-level @RequestMapping(method =
// RequestMethod.GET) instead of @GetMapping -- documented as unsupported (the scanner only
// matches the 5 verb-specific *Mapping annotations), not merely dropped by an edge-case regex
// backtrack.
@RestController
@RequestMapping("/request-mapping-style")
public class RequestMappingStyleController {

	@Operation(summary = "Not supported at all: @RequestMapping(method=...) instead of a verb-specific mapping", operationId = "requestMappingStyle")
	@RequestMapping(method = RequestMethod.GET)
	public ResponseEntity<Void> requestMappingStyle() {
		return ResponseEntity.ok(null);
	}
}
