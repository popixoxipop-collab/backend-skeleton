package com.example.demo.domain.widget.presentation.dto;

import com.example.demo.global.json.PatchField;
import jakarta.validation.constraints.NotNull;

import java.util.List;

// A3 (D-patch-strategy): one field per real classification bucket found across the oracle repo's
// 17 real update DTOs, so `bskel handles emit`'s generated patchField() codegen (and the fields it
// deliberately leaves manual) both get real, compiled proof against a single fixture --
// `label` = patch-wrapper, `capacity` = null-means-unchanged (both codegen-eligible), `ownerName`
// = fetch-merge-submit, `tags` = unsupported (both deliberately never auto-generated).
public record UpdateWidgetRequest(
		PatchField<String> label,
		Integer capacity,
		@NotNull String ownerName,
		List<String> tags
) {
}
