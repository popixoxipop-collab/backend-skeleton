package com.example.app.domain.annotationstyles.presentation;

import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): a known scanner limitation, isolated in its own file -- see
// AnnotationStyleController's file comment for why. Mapping annotation and `public` on the SAME
// line -- the scanner's regex requires a literal newline between them.
@RestController
@RequestMapping("/same-line")
public class SameLineMappingController {

	@Operation(summary = "Dropped: mapping and public on the same line", operationId = "sameLineMapping")
	@GetMapping public ResponseEntity<Void> sameLineMapping() {
		return ResponseEntity.ok(null);
	}
}
