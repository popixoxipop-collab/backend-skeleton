package com.example.app.domain.security.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// O5 (D-resolver-authorization-action-aware, hasAuthority follow-up): method-level
// @PreAuthorize(hasAuthority('X')), the sibling shape to Alpha's class-level hasRole('X') and
// Beta's method-level hasRole('X') -- proves the discriminant (baking Spring's implicit ROLE_
// prefix in for hasRole but NOT for hasAuthority) is applied correctly regardless of where in the
// method-vs-class search the match is found.
@RestController
@RequestMapping("/epsilons")
public class EpsilonController {

	@PreAuthorize("hasAuthority('EPSILON_ADMIN')")
	@Operation(summary = "Fetch a single epsilon", operationId = "findEpsilon")
	@GetMapping("/{epsilonId}")
	public ResponseEntity<EpsilonResponse> findEpsilon(@PathVariable UUID epsilonId) {
		return ResponseEntity.ok(null);
	}
}
