package org.sbf.fixture;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

@Path("/api/users")
@Produces(MediaType.TEXT_PLAIN)
public class UserResource {
    @GET
    @Path("/{id}")
    public String show(@PathParam("id") String id) {
        return id;
    }

    @POST
    public String create(String body) {
        return body;
    }
}
