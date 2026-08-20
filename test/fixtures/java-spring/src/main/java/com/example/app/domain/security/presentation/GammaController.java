package com.example.app.domain.security.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): @PreAuthorize IS present but not in the simple hasRole('X') shape this
// regex-based scanner understands -- findRequiredAuthority() must fail closed
// ({authority:null, unsupported:true}), never silently fall back to no-authority-found.
@RestController
@RequestMapping("/gammas")
public class GammaController {

	@PreAuthorize("hasAnyRole('GAMMA_ADMIN', 'GAMMA_OWNER')")
	@Operation(summary = "Fetch a single gamma", operationId = "findGamma")
	@GetMapping("/{gammaId}")
	public ResponseEntity<GammaResponse> findGamma(@PathVariable UUID gammaId) {
		return ResponseEntity.ok(null);
	}
}
