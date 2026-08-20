package com.example.app.domain.annotationstyles.presentation;

import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// P3 (D-fixture-corpus): a known scanner limitation, isolated in its own file -- see
// AnnotationStyleController's file comment for why. An annotation (here, @PreAuthorize) sitting
// BETWEEN the mapping annotation and the method's own "public" keyword breaks the scanner's
// mapping-then-newline-then-public shape. Deliberately avoid spelling the mapping annotation's
// own name immediately followed by "(" anywhere in THIS comment -- doing so once already created
// a SECOND, unintended match-start candidate for the very regex this fixture is documenting
// (found empirically while building this fixture). The mapping annotation below is deliberately
// BARE (no parenthesized argument at all): with an argument present, the regex's lazy backtrack
// can span forward past the intervening annotation and still land on this method's own real
// "public" line, and if that backtrack's captured span happens to contain only the mapping's own
// original quoted argument, the wrong-for-the-wrong-reason match can still produce the RIGHT
// path as an accident of there being nothing else quoted to confuse it with -- also found
// empirically. A bare mapping has no argument group to extend at all, so the match fails outright
// and the endpoint goes genuinely, unambiguously undetected (confirmed: not just missing an
// operationId, absent from the endpoint list altogether).
@RestController
@RequestMapping("/intervening")
public class InterveningAnnotationController {

	@Operation(summary = "Dropped: an intervening annotation between mapping and public", operationId = "interveningAnnotation")
	@GetMapping
	@PreAuthorize("hasRole('X')")
	public ResponseEntity<Void> interveningAnnotation() {
		return ResponseEntity.ok(null);
	}
}
