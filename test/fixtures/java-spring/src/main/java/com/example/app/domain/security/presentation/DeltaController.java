package com.example.app.domain.security.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): a real fetch operation exists (so findFetchOperation() succeeds), but
// there is no DeltaService.java under domain/security/application/ at all -- findServiceFile()
// must return null, and planHandles() must report "no resolver generated" with an explicit note
// naming the missing file, not silently guess or throw.
@RestController
@RequestMapping("/deltas")
public class DeltaController {

	@Operation(summary = "Fetch a single delta", operationId = "findDelta")
	@GetMapping("/{deltaId}")
	public ResponseEntity<DeltaResponse> findDelta(@PathVariable UUID deltaId) {
		return ResponseEntity.ok(null);
	}
}
