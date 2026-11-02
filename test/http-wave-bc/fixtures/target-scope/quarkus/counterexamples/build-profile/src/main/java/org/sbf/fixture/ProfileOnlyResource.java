package org.sbf.fixture;

import io.quarkus.arc.profile.IfBuildProfile;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@IfBuildProfile("prod")
@Path("/profile-only")
public class ProfileOnlyResource {
    @GET
    public String onlyWhenBuiltForProd() {
        return "prod";
    }
}
