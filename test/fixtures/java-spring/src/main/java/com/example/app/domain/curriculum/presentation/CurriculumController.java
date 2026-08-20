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

// P3 (D-fixture-corpus): reproduces a genuinely partial module -- 2 of 5 endpoints here carry a
// correlated operationId, the other 3 deliberately do NOT (via @Operation(summary=...) with no
// operationId field -- see G3's fixture note in memory: omitting @Operation entirely makes the
// "nearest preceding @Operation" correlation heuristic wrongly inherit the PREVIOUS method's
// operationId, which is not the shape being tested here).
@RestController
@RequestMapping("/curricula")
public class CurriculumController {

	@Operation(
		summary = "List curricula",
		operationId = "findCurricula"
	)
	@GetMapping
	public ResponseEntity<CurriculumListResponse> findCurricula() {
		return ResponseEntity.ok(null);
	}

	@Operation(
		summary = "Fetch a single curriculum",
		operationId = "findCurriculum"
	)
	@GetMapping("/{curriculumId}")
	public ResponseEntity<CurriculumResponse> findCurriculum(@PathVariable UUID curriculumId) {
		return ResponseEntity.ok(null);
	}

	@Operation(summary = "Create a curriculum -- operationId not yet assigned by the API team")
	@PostMapping
	public ResponseEntity<CurriculumResponse> createCurriculum() {
		return ResponseEntity.ok(null);
	}

	@Operation(summary = "Archive a curriculum -- operationId not yet assigned by the API team")
	@PostMapping("/{curriculumId}/archive")
	public ResponseEntity<CurriculumResponse> archiveCurriculum(@PathVariable UUID curriculumId) {
		return ResponseEntity.ok(null);
	}

	@Operation(summary = "Delete a curriculum -- operationId not yet assigned by the API team")
	@DeleteMapping("/{curriculumId}")
	public ResponseEntity<Void> deleteCurriculum(@PathVariable UUID curriculumId) {
		return ResponseEntity.ok(null);
	}
}
