package org.sbf.fixture;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

@Path("/duplicate")
public class SecondResource {
    @GET
    @Produces(MediaType.TEXT_PLAIN)
    public String second() {
        return "second";
    }
}
