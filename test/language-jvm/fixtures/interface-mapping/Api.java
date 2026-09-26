package com.example.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@RequestMapping("/widgets")
public interface WidgetApi extends BaseApi<WidgetDto> {
    @GetMapping("/{id}")
    WidgetDto get(String id);
}

interface BaseApi<T> {}
record WidgetDto(String id) {}
