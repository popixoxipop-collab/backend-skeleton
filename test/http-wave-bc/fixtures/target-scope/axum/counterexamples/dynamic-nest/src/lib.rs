use axum::{routing::get, Router};

async fn user() -> &'static str { "user" }

// The prefix comes from a caller. No static literal route may be invented.
pub fn app(prefix: &str) -> Router {
    let users = Router::new().route("/users/{id}", get(user));
    Router::new().nest(prefix, users)
}
