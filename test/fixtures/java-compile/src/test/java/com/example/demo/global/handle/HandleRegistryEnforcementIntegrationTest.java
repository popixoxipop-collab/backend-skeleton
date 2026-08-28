package com.example.demo.global.handle;

import com.example.demo.domain.widget.domain.Widget;
import com.example.demo.domain.widget.infrastructure.WidgetRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * O3 (D-handle-registry-enforcement): proves the opt-in registry cross-check actually gates
 * {@code fetch()} (and, by the same shared {@code requireRegisteredOrThrow} helper, {@code
 * patch()}) once {@code ENFORCE_REGISTRY} is baked {@code true} at {@code bskel handles emit
 * --enforce-registry on} time. Run as a SEPARATE phase by {@code scripts/java-integration-smoke.mjs}
 * from {@link HandleLifecycleIntegrationTest} -- {@code ENFORCE_REGISTRY} is a compile-time-baked
 * constant, not runtime-configurable, so exercising both postures needs two separate {@code
 * handles emit}+recompile passes, not one test class toggling a flag.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Import(TestSecurityConfig.class)
class HandleRegistryEnforcementIntegrationTest {

	@LocalServerPort
	int port;

	@Autowired
	TestRestTemplate restTemplate;

	@Autowired
	WidgetRepository widgetRepository;

	@Autowired
	HandleService handleService;

	private static final UUID FEATURE_UID = UUID.fromString("00000000-0000-0000-0000-000000000000");

	private String url(String path) {
		return "http://localhost:" + port + path;
	}

	private Widget seedWidget(String name) {
		Widget widget = new Widget();
		widget.setId(UUID.randomUUID());
		widget.setName(name);
		return widgetRepository.save(widget);
	}

	// The real bug this whole item exists to fix: before O3 part 2, HandleService.revoke()
	// (and simply never registering a handle at all) had ZERO effect on fetch() -- only recover()
	// enforced the registry. With ENFORCE_REGISTRY baked true, a handle nobody ever registered via
	// HandleService.register() (the ONLY generated call site that ever mints a token, see
	// D-handle-uid-type-binding) must now be rejected, not silently served.
	@Test
	void anUnregisteredHandleIsRejectedWhenEnforcementIsOn() {
		Widget widget = seedWidget("never-registered");
		String handle = HandleCodec.encode("r", "Widget", widget.getId(), null);

		ResponseEntity<String> response = restTemplate.getForEntity(url("/handles/" + handle), String.class);
		assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
	}

	@Test
	void aRegisteredNonRevokedHandleStillFetchesFineWhenEnforcementIsOn() {
		Widget widget = seedWidget("registered-and-active");
		handleService.register("r", "Widget", widget.getId(), null, FEATURE_UID, "seed", "contract-ref");
		String handle = HandleCodec.encode("r", "Widget", widget.getId(), null);

		ResponseEntity<String> response = restTemplate.getForEntity(url("/handles/" + handle), String.class);
		assertEquals(HttpStatus.OK, response.getStatusCode());
	}

	// The other half of the real bug: HandleService.revoke() genuinely had no effect on fetch()
	// before this item. A handle that WAS registered, then explicitly revoked, must now 404 --
	// proving revocation is no longer decorative.
	@Test
	void aRevokedHandleIsRejectedEvenThoughItWasOnceRegisteredWhenEnforcementIsOn() {
		Widget widget = seedWidget("registered-then-revoked");
		handleService.register("r", "Widget", widget.getId(), null, FEATURE_UID, "seed", "contract-ref");
		UUID handleUid = HandleCodec.deriveHandleUid("r", "Widget", widget.getId(), null);
		handleService.revoke(handleUid, "compromised");
		String handle = HandleCodec.encode("r", "Widget", widget.getId(), null);

		ResponseEntity<String> response = restTemplate.getForEntity(url("/handles/" + handle), String.class);
		assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
	}

	// The opt-in path this item's own HandleAspect already provides: register() is called
	// automatically for kind=r by @RecordHandleSnapshot's interceptor (see HandleAspect.record()),
	// so an app already using snapshot recording gets a working registry "for free" for every
	// interaction AFTER the resource's first one -- but NOT for the resource's very first field
	// PATCH, a real, structural constraint found live while writing this test (not assumed): the
	// aspect only fires AFTER resolver.patchField() succeeds, and patchField() only runs AFTER
	// this handle passes requireRegisteredOrThrow -- so a never-registered resource can never
	// bootstrap its own registration through a PATCH call alone, no matter which registry-row
	// granularity the check looks up. A real target app integrating --enforce-registry on must
	// call HandleService.register() explicitly at least once per resource (e.g. from its own
	// create-flow) before ANY enforced fetch/patch against it can succeed -- documented as a real
	// requirement in D-handle-registry-enforcement, not silently assumed away.
	//
	// This test proves the ACHIEVABLE half of that story: once a resource IS registered (here,
	// simulating that create-flow explicitly), a field-level PATCH against it correctly finds the
	// PARENT resource's registry row (this item's own parent-lookup fix -- the field handle's OWN
	// derived UID was never registered, and never needs to be), and the aspect's own re-register()
	// call on top (a refresh of an already-existing row, not a fresh insert) does not break it.
	@Test
	void aFieldPatchOnAnAlreadyRegisteredResourceSucceedsAndTheAspectRefreshesItsRegistrationWhenEnforcementIsOn() throws Exception {
		Widget widget = seedWidget("registered-then-field-patched");
		handleService.register("r", "Widget", widget.getId(), null, FEATURE_UID, "seed", "contract-ref");

		java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder(java.net.URI.create(url("/handles/" + HandleCodec.encode("f", "Widget", widget.getId(), "/label"))))
				.header("Content-Type", "application/json")
				.method("PATCH", java.net.http.HttpRequest.BodyPublishers.ofString("\"patched-after-registration\""))
				.build();
		java.net.http.HttpResponse<String> patchResponse = java.net.http.HttpClient.newHttpClient().send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
		assertEquals(HttpStatus.NO_CONTENT.value(), patchResponse.statusCode());

		String resourceHandle = HandleCodec.encode("r", "Widget", widget.getId(), null);
		ResponseEntity<String> response = restTemplate.getForEntity(url("/handles/" + resourceHandle), String.class);
		assertEquals(HttpStatus.OK, response.getStatusCode());
	}
}
