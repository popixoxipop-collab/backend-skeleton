package org.sbf.fixture;

import io.micronaut.http.annotation.Body;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Post;

@Controller("/api/users")
public class UserController {
    @Get("/{id}")
    public String show(String id) {
        return id;
    }

    @Post
    public String create(@Body String body) {
        return body;
    }
}
