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

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * O4 (D-handle-lifecycle): the deepest verification this project has attempted -- a genuinely
 * running Spring Boot app, real HTTP calls, a real (disposable) Postgres. Requires
 * {@code BSKEL_TEST_DB_USER}/{@code BSKEL_TEST_DB_NAME} (see {@code application-test.yml}) to
 * point at a database that already has the REAL emitted {@code migration.sql} (sbf_handle /
 * sbf_handle_snapshot) and a {@code widgets} table applied -- {@code
 * scripts/java-integration-smoke.mjs} does this before invoking {@code ./gradlew test}, the same
 * way {@code db-introspect-smoke.mjs} (A4) sets up its own throwaway tables. Never run as part of
 * the fast default {@code ./gradlew compileJava} path -- this is a separate, DB-touching job.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Import(TestSecurityConfig.class)
class HandleLifecycleIntegrationTest {

	@LocalServerPort
	int port;

	@Autowired
	TestRestTemplate restTemplate;

	@Autowired
	WidgetRepository widgetRepository;

	@Autowired
	HandleRegistryRepository handleRegistryRepository;

	@Autowired
	HandleSnapshotRepository handleSnapshotRepository;

	@Autowired
	HandleService handleService;

	private String url(String path) {
		return "http://localhost:" + port + path;
	}

	private Widget seedWidget(String name) {
		Widget widget = new Widget();
		widget.setId(UUID.randomUUID());
		widget.setName(name);
		return widgetRepository.save(widget);
	}

	// TestRestTemplate's default request factory is backed by java.net.HttpURLConnection, which
	// throws ProtocolException on PATCH (it only allows the fixed method set HttpURLConnection
	// itself hardcodes) -- confirmed live, not assumed, by a real failing run before this existed.
	// java.net.http.HttpClient (JDK 11+) has no such restriction, so PATCH goes through it
	// directly instead of trying to reconfigure TestRestTemplate's request factory.
	private HttpResponse<String> patch(String path, String jsonBody) throws IOException, InterruptedException {
		HttpRequest request = HttpRequest.newBuilder(URI.create(url(path)))
				.header("Content-Type", "application/json")
				.method("PATCH", HttpRequest.BodyPublishers.ofString(jsonBody))
				.build();
		return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
	}

	/**
	 * The full real lifecycle O4's own plan promised: a real HTTP field-level PATCH (routed
	 * through {@code HandleController} -&gt; {@code WidgetResolver#patchField} -&gt;
	 * {@code Validator#validateProperty} -- this exact path is what caught the real
	 * D-patch-strategy validation bug this item found and fixed, see DECISIONS.md) -&gt;
	 * {@code WidgetServiceImpl#updateWidget} (annotated {@code @RecordHandleSnapshot}) -&gt;
	 * {@code HandleAspect} fires for real -&gt; a real HTTP GET {@code recover} returns the
	 * real recorded payload with {@code schema_drift:false} (same running app, same {@code
	 * WidgetResolver#contractRef()} value both times it's read).
	 */
	@Test
	void fieldPatchThroughHandleTriggersAspectAndRecoverReturnsTheRecordedSnapshot() throws IOException, InterruptedException {
		Widget widget = seedWidget("original-name");
		String fieldHandle = HandleCodec.encode("f", "Widget", widget.getId(), "/label");

		HttpResponse<String> patchResponse = patch("/handles/" + fieldHandle, "\"patched-via-handle\"");
		assertEquals(HttpStatus.NO_CONTENT.value(), patchResponse.statusCode());

		// Proves the patch genuinely reached WidgetServiceImpl -> the repository, not just that
		// the endpoint returned 204 -- also proves the validateProperty fix: before it, this
		// PATCH always 500'd (ConstraintViolationException on ownerName's @NotNull, never
		// actually related to the field being patched).
		Widget reloaded = widgetRepository.findById(widget.getId()).orElseThrow();
		assertEquals("patched-via-handle", reloaded.getName());

		String resourceHandle = HandleCodec.encode("r", "Widget", widget.getId(), null);
		@SuppressWarnings("unchecked")
		ResponseEntity<Map<String, Object>> recoverResponse = (ResponseEntity<Map<String, Object>>) (ResponseEntity<?>)
				restTemplate.getForEntity(url("/handles/" + resourceHandle + "/recover"), Map.class);
		assertEquals(HttpStatus.OK, recoverResponse.getStatusCode());
		Map<String, Object> body = recoverResponse.getBody();
		assertEquals("updateWidget", body.get("operation_id"));
		assertEquals(Boolean.FALSE, body.get("schema_drift"));
		@SuppressWarnings("unchecked")
		Map<String, Object> payload = (Map<String, Object>) body.get("payload");
		assertEquals("patched-via-handle", payload.get("name"));
	}

	/**
	 * {@code recover}'s {@code schema_drift} branch, proven directly against real registry/
	 * snapshot rows -- drift means the REGISTRY row (refreshed on every {@link
	 * HandleService#register}) has since moved to a newer contract than the snapshot being
	 * recovered still carries, i.e. exactly what a real contract change + redeploy (re-register
	 * under a new {@code contractRef}, but no NEW snapshot recorded yet) looks like: register
	 * under contract A, record a snapshot under A, then re-register under contract B without a
	 * matching new snapshot -- the still-latest snapshot (A) must now read back as drifted
	 * relative to the registry's current contract (B). A real contract EDIT + re-emit + recompile
	 * + app restart mid-JUnit-run is out of scope for a single test process (already proven
	 * separately -- CONTRACT_REF is a baked constant recomputed from the contract file's real
	 * content hash every {@code handles emit} run, confirmed live during this item's own manual
	 * verification); this proves {@code recover}'s COMPARISON logic itself, using {@link
	 * HandleService} directly the same way a real re-registration after a contract change would.
	 */
	@Test
	void recoverReportsSchemaDriftWhenSnapshotContractHashDoesNotMatchTheCurrentResolver() {
		Widget widget = seedWidget("drift-target");
		UUID featureUid = UUID.fromString("00000000-0000-0000-0000-000000000000");
		String contractHashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		String contractHashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

		String token = handleService.register("r", "Widget", widget.getId(), null, featureUid, "seed", contractHashA);
		String resourceHandle = HandleCodec.encode("r", "Widget", widget.getId(), null);
		assertEquals(token, resourceHandle, "HandleService.register's own encoded token must match HandleCodec.encode for the same inputs");

		UUID handleUid = HandleCodec.deriveHandleUid("r", "Widget", widget.getId(), null);
		handleService.recordSnapshot(handleUid, "response", "seed", contractHashA, Map.of("name", "drift-target"));

		// Simulates a redeploy under a changed contract: the registry row is refreshed to B, but
		// no new snapshot has been recorded yet -- the snapshot from the A registration is still
		// the latest one recover() finds.
		handleService.register("r", "Widget", widget.getId(), null, featureUid, "seed", contractHashB);

		@SuppressWarnings("unchecked")
		ResponseEntity<Map<String, Object>> recoverResponse = (ResponseEntity<Map<String, Object>>) (ResponseEntity<?>)
				restTemplate.getForEntity(url("/handles/" + resourceHandle + "/recover"), Map.class);
		assertEquals(HttpStatus.OK, recoverResponse.getStatusCode());
		assertEquals(Boolean.TRUE, recoverResponse.getBody().get("schema_drift"));
	}

	/** kind=f GET -- {@code JsonNode#at} resolving a real field, and 404ing a genuinely missing one. */
	@Test
	void fieldFetchResolvesARealPointerAnd404sAMissingOne() {
		Widget widget = seedWidget("fetchable-name");

		String nameHandle = HandleCodec.encode("f", "Widget", widget.getId(), "/name");
		ResponseEntity<String> ok = restTemplate.getForEntity(url("/handles/" + nameHandle), String.class);
		assertEquals(HttpStatus.OK, ok.getStatusCode());
		assertEquals("\"fetchable-name\"", ok.getBody());

		String missingHandle = HandleCodec.encode("f", "Widget", widget.getId(), "/doesNotExist");
		ResponseEntity<String> missing = restTemplate.getForEntity(url("/handles/" + missingHandle), String.class);
		assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
	}

	/**
	 * D-handle-lifecycle's redaction design, proven at the PERSISTENCE layer (not the response the
	 * caller sees) -- a {@code redact}-listed pointer must be genuinely absent from the stored
	 * {@code payload} column, matching this item's own plan text exactly.
	 */
	@Test
	void redactedPointerIsAbsentFromThePersistedSnapshotPayloadNotJustTheResponse() throws IOException, InterruptedException {
		Widget widget = seedWidget("redaction-target");
		String requestBody = """
				{"label": {"value": "still-visible"}, "capacity": 3, "ownerName": "SECRET-owner-value", "tags": []}""";

		HttpResponse<String> patchResponse = patch("/widgets/" + widget.getId(), requestBody);
		assertEquals(HttpStatus.OK.value(), patchResponse.statusCode());

		UUID handleUid = HandleCodec.deriveHandleUid("r", "Widget", widget.getId(), null);
		List<HandleSnapshot> snapshots = handleSnapshotRepository.findByHandleUidOrderByRecordedAtDesc(handleUid);
		HandleSnapshot requestSnapshot = snapshots.stream()
				.filter(s -> s.getEnvelopeDir().equals("request"))
				.findFirst()
				.orElseThrow(() -> new AssertionError("no \"request\" envelope was recorded -- HandleAspect did not fire"));

		assertFalse(requestSnapshot.getPayload().contains("SECRET-owner-value"),
				"the redacted value must be genuinely absent from the persisted payload column, not merely omitted from the HTTP response: " + requestSnapshot.getPayload());
		assertTrue(requestSnapshot.getPayload().contains("REDACTED"));
		assertTrue(requestSnapshot.getPayload().contains("still-visible"),
				"only /ownerName was named in redact() -- /label must still be recorded in full");
	}
}
