package com.example.app.global.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.HandlerTypePredicate;
import org.springframework.web.servlet.config.annotation.PathMatchConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

// P3 (D-fixture-corpus): reproduces the real defect A1 §7 exists to detect -- a global path
// prefix applied entirely outside any single controller's own annotations, invisible to a
// per-file regex scanner. See scanners/adapters/java-spring.mjs::detectGlobalPathPrefixSignals().
@Configuration
public class ApiPathConfig implements WebMvcConfigurer {
	@Override
	public void configurePathMatch(PathMatchConfigurer configurer) {
		configurer.addPathPrefix("/api/v0", HandlerTypePredicate.forBasePackage("com.example.app.domain"));
	}
}
