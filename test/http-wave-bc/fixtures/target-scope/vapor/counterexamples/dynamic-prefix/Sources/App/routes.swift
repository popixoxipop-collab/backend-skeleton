import Vapor

public func routes(_ app: Application) throws {
    let prefix = Environment.get("API_PREFIX") ?? "api"
    let group = app.grouped(PathComponent(stringLiteral: prefix))
    group.get("users") { _ -> String in "users" }
}
