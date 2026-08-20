package com.example.demo.domain.widget.application;

import java.util.UUID;
import com.example.demo.domain.widget.domain.Widget;

public interface WidgetService {
	Widget findWidget(UUID widgetId);
}
