use axum::{routing::{get, post}, Router};

async fn health() -> &'static str { "ok" }
async fn user() -> &'static str { "user" }
async fn create_user() -> &'static str { "created" }

pub fn app() -> Router {
    let users = Router::new()
        .route("/users/{id}", get(user))
        .route("/users", post(create_user));
    Router::new()
        .route("/health", get(health))
        .nest("/api", users)
}
