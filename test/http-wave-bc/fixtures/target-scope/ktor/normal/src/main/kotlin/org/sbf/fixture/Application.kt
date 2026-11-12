package org.sbf.fixture

import io.ktor.server.application.Application
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing

fun Application.module() {
    routing {
        route("/api") {
            get("/users/{id}") {
                call.respondText("user:" + call.parameters["id"])
            }
            post("/users") {
                call.respondText("created")
            }
        }
    }
}
