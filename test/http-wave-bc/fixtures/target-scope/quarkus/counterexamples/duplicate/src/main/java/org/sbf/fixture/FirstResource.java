package org.sbf.fixture;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

@Path("/duplicate")
public class FirstResource {
    @GET
    @Produces(MediaType.TEXT_PLAIN)
    public String first() {
        return "first";
    }
}
