package com.example.demo.global.handle;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * O4 (D-handle-lifecycle): test-only security wiring -- the fixture app has no real
 * {@code SecurityFilterChain}/{@code UserDetailsService} of its own (never needed one before this
 * item, since nothing was ever actually RUN). Unconditionally stamps a {@code ROLE_ADMIN}
 * authentication onto every request before it reaches a controller, which is enough to satisfy
 * both {@code @PreAuthorize("hasRole('ADMIN')")} (needs {@link EnableMethodSecurity}, not on by
 * default in Spring Security 6) and {@code HandleController}'s own manual
 * {@code SecurityContextHolder} check -- this test cares whether the HANDLE LIFECYCLE plumbing
 * works, not whether a real login flow does.
 */
@TestConfiguration
@EnableMethodSecurity
public class TestSecurityConfig {

	@Bean
	public SecurityFilterChain testSecurityFilterChain(HttpSecurity http) throws Exception {
		http
				.csrf(csrf -> csrf.disable())
				.authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
				.addFilterBefore(new OncePerRequestFilter() {
					@Override
					protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
						SecurityContextHolder.getContext().setAuthentication(
								new TestingAuthenticationToken("integration-test", null, "ROLE_ADMIN"));
						chain.doFilter(request, response);
					}
				}, UsernamePasswordAuthenticationFilter.class);
		return http.build();
	}
}
