package com.example.app.domain.organization.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): a second controller in the SAME module whose basePath is a SUPERSET of
// OrganizationController's ("/organizations/{organizationId}/operators" vs "/organizations") --
// reproduces the real multi-controller shape that motivated handles/providers/java-spring/plan.mjs's
// findFetchOperation() name-affinity fix (className must contain the entity name; basePath prefix
// overlap alone is not enough). This controller's className ("OperatorController") does not
// contain "Organization", so it must never be considered when planning the Organization resolver.
@RestController
@RequestMapping("/organizations/{organizationId}/operators")
public class OperatorController {

	@Operation(
		summary = "List an organization's operators",
		description = """
			Returns every operator account with access to the given
			organization.
			""",
		operationId = "findOperators"
	)
	@GetMapping
	public ResponseEntity<OperatorListResponse> findOperators(@PathVariable UUID organizationId) {
		return ResponseEntity.ok(null);
	}

	@Operation(
		summary = "Fetch a single operator",
		description = """
			Returns one operator's detail record within the given
			organization.
			""",
		operationId = "findOperator"
	)
	@GetMapping("/{operatorId}")
	public ResponseEntity<OperatorResponse> findOperator(@PathVariable UUID organizationId, @PathVariable UUID operatorId) {
		return ResponseEntity.ok(null);
	}

	@Operation(
		summary = "Invite an operator",
		description = """
			Sends an invitation email and creates a pending operator record
			for the given organization.
			""",
		operationId = "inviteOperator"
	)
	@PostMapping
	public ResponseEntity<OperatorResponse> inviteOperator(@PathVariable UUID organizationId, @RequestBody InviteOperatorRequest request) {
		return ResponseEntity.ok(null);
	}

	@Operation(
		summary = "Update an operator's role",
		description = """
			Changes an existing operator's role within the given
			organization.
			""",
		operationId = "updateOperatorRole"
	)
	@PutMapping("/{operatorId}")
	public ResponseEntity<OperatorResponse> updateOperatorRole(@PathVariable UUID organizationId, @PathVariable UUID operatorId, @RequestBody UpdateOperatorRoleRequest request) {
		return ResponseEntity.ok(null);
	}

	@Operation(
		summary = "Remove an operator",
		description = """
			Revokes an operator's access to the given organization.
			""",
		operationId = "removeOperator"
	)
	@DeleteMapping("/{operatorId}")
	public ResponseEntity<Void> removeOperator(@PathVariable UUID organizationId, @PathVariable UUID operatorId) {
		return ResponseEntity.ok(null);
	}
}
