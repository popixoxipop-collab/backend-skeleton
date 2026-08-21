package com.example.demo.domain.widget.application;

import java.util.UUID;
import com.example.demo.domain.widget.domain.Widget;
import com.example.demo.domain.widget.presentation.dto.UpdateWidgetRequest;

public interface WidgetService {
	Widget findWidget(UUID widgetId);

	// A3 (D-patch-strategy): the (resource id, request DTO) 2-arg shape generated patchField()
	// codegen always assumes -- see plan.mjs's countServiceMethodParams() safety check.
	Widget updateWidget(UUID widgetId, UpdateWidgetRequest request);
}
