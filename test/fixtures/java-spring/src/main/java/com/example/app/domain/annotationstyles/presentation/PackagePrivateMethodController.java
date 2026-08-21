package com.example.app.domain.annotationstyles.presentation;

import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// A2 Phase 1 (D-java-analyzer): a method with NO access modifier at all (package-private) --
// still a legal Spring endpoint (component scanning/reflection don't require `public`), but the
// old scanner's regex hardcoded `public\s+\S+\s+(\w+)\s*\(` and could never match this shape at
// all. See AnnotationStyleController's file comment for the fixture-isolation convention.
@RestController
@RequestMapping("/package-private")
public class PackagePrivateMethodController {

	@Operation(summary = "Fixed (A2 Phase 1): no access modifier at all", operationId = "packagePrivateMethod")
	@GetMapping
	ResponseEntity<Void> packagePrivateMethod() {
		return ResponseEntity.ok(null);
	}
}
