package com.example.app.domain.curriculum.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): a second controller in the curriculum module -- none of its 3 endpoints
// carry an operationId (same @Operation(summary=...)-without-operationId shape as
// CurriculumController's unmatched trio, for the same reason).
@RestController
@RequestMapping("/curricula/{curriculumId}/materials")
public class CurriculumMaterialController {

	@Operation(summary = "List a curriculum's materials -- operationId not yet assigned by the API team")
	@GetMapping
	public ResponseEntity<MaterialListResponse> findMaterials(@PathVariable UUID curriculumId) {
		return ResponseEntity.ok(null);
	}

	@Operation(summary = "Add a material to a curriculum -- operationId not yet assigned by the API team")
	@PostMapping
	public ResponseEntity<MaterialResponse> addMaterial(@PathVariable UUID curriculumId) {
		return ResponseEntity.ok(null);
	}

	@Operation(summary = "Remove a material from a curriculum -- operationId not yet assigned by the API team")
	@DeleteMapping("/{materialId}")
	public ResponseEntity<Void> removeMaterial(@PathVariable UUID curriculumId, @PathVariable UUID materialId) {
		return ResponseEntity.ok(null);
	}
}
