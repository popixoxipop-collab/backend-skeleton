package com.example.app.domain.security.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus) / D-security-7 regression: two methods, each with its OWN, DIFFERENT
// @PreAuthorize role. findBeta (the fetch operation planHandles() targets) must resolve to its
// own "BETA_ADMIN", never findBetas' "BETA_VIEWER" -- the exact bug class the Codex security
// review found (a controller's FIRST @PreAuthorize match silently applied to every method).
@RestController
@RequestMapping("/betas")
public class BetaController {

	@PreAuthorize("hasRole('BETA_VIEWER')")
	@Operation(summary = "List betas", operationId = "findBetas")
	@GetMapping
	public ResponseEntity<BetaListResponse> findBetas() {
		return ResponseEntity.ok(null);
	}

	@PreAuthorize("hasRole('BETA_ADMIN')")
	@Operation(summary = "Fetch a single beta", operationId = "findBeta")
	@GetMapping("/{betaId}")
	public ResponseEntity<BetaResponse> findBeta(@PathVariable UUID betaId) {
		return ResponseEntity.ok(null);
	}
}
