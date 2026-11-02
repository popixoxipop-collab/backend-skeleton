import Vapor

public func routes(_ app: Application) throws {
    app.get("files", "**") { req -> String in
        req.parameters.getCatchall().joined(separator: "/")
    }
}
