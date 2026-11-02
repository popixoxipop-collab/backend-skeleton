package org.sbf.fixture;

import io.micronaut.context.annotation.Requires;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;

@Requires(property = "feature.users", value = "enabled")
@Controller("/conditional")
public class FeatureController {
    @Get
    public String show() {
        return "enabled";
    }
}
