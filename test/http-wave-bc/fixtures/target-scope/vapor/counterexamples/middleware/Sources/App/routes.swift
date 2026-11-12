import Vapor

struct TokenGate: AsyncMiddleware {
    func respond(to request: Request, chainingTo next: AsyncResponder) async throws -> Response {
        guard request.headers.first(name: "x-token") == "ok" else {
            throw Abort(.unauthorized)
        }
        return try await next.respond(to: request)
    }
}

public func routes(_ app: Application) throws {
    let guarded = app.grouped(TokenGate())
    guarded.get("private", "users") { _ -> String in "users" }
}
