package com.example.app.domain.security.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): @PreAuthorize on the CLASS, not any individual method -- exercises
// handles/providers/java-spring/plan.mjs::findRequiredAuthority()'s class-level fallback branch
// (no method-level @PreAuthorize exists anywhere in this file, so the search falls all the way
// back to classRegion).
@PreAuthorize("hasRole('ALPHA_ADMIN')")
@RestController
@RequestMapping("/alphas")
public class AlphaController {

	@Operation(summary = "Fetch a single alpha", operationId = "findAlpha")
	@GetMapping("/{alphaId}")
	public ResponseEntity<AlphaResponse> findAlpha(@PathVariable UUID alphaId) {
		return ResponseEntity.ok(null);
	}
}
