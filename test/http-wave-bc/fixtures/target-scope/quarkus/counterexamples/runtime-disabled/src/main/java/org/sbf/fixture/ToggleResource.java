package org.sbf.fixture;

import io.quarkus.resteasy.reactive.server.EndpointDisabled;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@EndpointDisabled(name = "feature.users", stringValue = "disabled")
@Path("/toggle")
public class ToggleResource {
    @GET
    public String show() {
        return "enabled";
    }
}
