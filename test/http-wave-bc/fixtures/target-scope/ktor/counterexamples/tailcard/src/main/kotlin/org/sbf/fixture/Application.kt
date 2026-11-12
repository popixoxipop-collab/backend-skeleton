package org.sbf.fixture

import io.ktor.server.application.Application
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing

fun Application.module() {
    routing {
        get("/assets/{parts...}") {
            call.respondText(call.parameters.getAll("parts")?.joinToString("/") ?: "root")
        }
    }
}
