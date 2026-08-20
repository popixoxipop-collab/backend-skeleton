package com.example.demo.domain.widget.presentation;

import java.util.UUID;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.example.demo.domain.widget.presentation.dto.WidgetResponse;

@RestController
@RequestMapping("/widgets")
public class WidgetController {

	@PreAuthorize("hasRole('ADMIN')")
	@Operation(summary = "Fetch a single widget", operationId = "findWidget")
	@GetMapping("/{widgetId}")
	public ResponseEntity<WidgetResponse> findWidget(@PathVariable UUID widgetId) {
		return ResponseEntity.ok(null);
	}
}
