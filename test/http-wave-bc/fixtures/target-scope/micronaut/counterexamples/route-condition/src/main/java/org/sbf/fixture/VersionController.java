package org.sbf.fixture;

import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.RouteCondition;

@Controller("/version")
public class VersionController {
    @Get
    @RouteCondition("#{request.parameters.getFirst('v').orElse(null) != '2'}")
    public String v1() {
        return "v1";
    }

    @Get
    @RouteCondition("#{request.parameters.getFirst('v').orElse(null) == '2'}")
    public String v2() {
        return "v2";
    }
}
