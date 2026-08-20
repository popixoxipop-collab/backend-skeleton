package com.example.app.domain.annotationstyles.presentation;

import java.util.Map;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): a known scanner limitation, isolated in its own file -- see
// AnnotationStyleController's file comment for why. A space inside the generic return type
// (`Map<String, Object>`) breaks the scanner's `\S+` (no-whitespace) return-type match.
@RestController
@RequestMapping("/generic-space")
public class GenericWithSpaceController {

	@Operation(summary = "Dropped: whitespace inside a generic return type", operationId = "genericWithSpace")
	@GetMapping
	public ResponseEntity<Map<String, Object>> genericWithSpace() {
		return ResponseEntity.ok(null);
	}
}
