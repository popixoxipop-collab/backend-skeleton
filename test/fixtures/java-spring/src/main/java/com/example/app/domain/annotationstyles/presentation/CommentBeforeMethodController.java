package com.example.app.domain.annotationstyles.presentation;

import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): a known scanner limitation, isolated in its own file -- see
// AnnotationStyleController's file comment for why. A comment between the mapping annotation and
// `public` is not whitespace, so it breaks the same shape as InterveningAnnotationController.
@RestController
@RequestMapping("/comment-before")
public class CommentBeforeMethodController {

	@Operation(summary = "Dropped: a comment between mapping and public", operationId = "commentBeforeMethod")
	@GetMapping
	// TODO: consider caching this response
	public ResponseEntity<Void> commentBeforeMethod() {
		return ResponseEntity.ok(null);
	}
}
