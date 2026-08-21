package com.example.demo.domain.widget.application;

import com.example.demo.domain.widget.domain.Widget;
import com.example.demo.domain.widget.infrastructure.WidgetRepository;
import com.example.demo.domain.widget.presentation.dto.UpdateWidgetRequest;
import com.example.demo.global.handle.RecordHandleSnapshot;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

import java.util.UUID;

// O4 (D-handle-lifecycle): the real implementation java-compile-smoke.mjs's stub-only
// WidgetController never had -- needed so the handle-lifecycle integration test exercises a
// genuinely running app, not a compile check. @RecordHandleSnapshot is applied here (the
// concrete implementation), not on the WidgetService interface method -- Spring AOP's
// @annotation pointcut resolves the annotation off the invoked class via
// AopUtils#getMostSpecificMethod, which is reliable for BOTH JDK dynamic proxies (interface-based,
// what Spring uses here since this class implements an interface) and CGLIB, whereas an
// interface-only annotation is only guaranteed visible through a JDK proxy.
@Service
@RequiredArgsConstructor
public class WidgetServiceImpl implements WidgetService {

	private final WidgetRepository widgetRepository;

	@Override
	public Widget findWidget(UUID widgetId) {
		return widgetRepository.findById(widgetId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no widget " + widgetId));
	}

	@Override
	@RecordHandleSnapshot(resourceType = "Widget", operationId = "updateWidget", resourceUidParam = 0, redact = {"/ownerName"})
	public Widget updateWidget(UUID widgetId, UpdateWidgetRequest request) {
		Widget widget = findWidget(widgetId);
		if (request.label() != null) {
			widget.setName(request.label().value());
		}
		return widgetRepository.save(widget);
	}
}
