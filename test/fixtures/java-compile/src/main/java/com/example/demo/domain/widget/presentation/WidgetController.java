package com.example.demo.domain.widget.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.example.demo.domain.widget.application.WidgetService;
import com.example.demo.domain.widget.domain.Widget;
import com.example.demo.domain.widget.presentation.dto.UpdateWidgetRequest;
import com.example.demo.domain.widget.presentation.dto.WidgetResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/widgets")
@RequiredArgsConstructor
public class WidgetController {

	private final WidgetService widgetService;

	@PreAuthorize("hasRole('ADMIN')")
	@Operation(summary = "Fetch a single widget", operationId = "findWidget")
	@GetMapping("/{widgetId}")
	public ResponseEntity<WidgetResponse> findWidget(@PathVariable UUID widgetId) {
		Widget widget = widgetService.findWidget(widgetId);
		return ResponseEntity.ok(new WidgetResponse(widget.getId(), widget.getName()));
	}

	// A3 (D-patch-strategy): the update endpoint findUpdateOperation() locates -- same
	// single-path-param shape as findWidget() above, just PATCH instead of GET.
	@PreAuthorize("hasRole('ADMIN')")
	@Operation(summary = "Update a widget", operationId = "updateWidget")
	@PatchMapping("/{widgetId}")
	public ResponseEntity<WidgetResponse> updateWidget(@PathVariable UUID widgetId, @Valid @RequestBody UpdateWidgetRequest request) {
		Widget widget = widgetService.updateWidget(widgetId, request);
		return ResponseEntity.ok(new WidgetResponse(widget.getId(), widget.getName()));
	}
}
