import Vapor

public func routes(_ app: Application) throws {
    let api = app.grouped("api")
    let users = api.grouped("users")

    users.get(":id") { req -> String in
        req.parameters.get("id") ?? "missing"
    }
    users.post { _ -> HTTPStatus in
        .created
    }
}
