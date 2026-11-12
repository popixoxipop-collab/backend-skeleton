import Vapor

struct UserRoutes: RouteCollection {
    func boot(routes: RoutesBuilder) throws {
        let users = routes.grouped("users")
        users.get { _ -> String in "index" }
        users.get(":id") { req -> String in req.parameters.get("id") ?? "missing" }
    }
}

public func routes(_ app: Application) throws {
    try app.register(collection: UserRoutes())
}
