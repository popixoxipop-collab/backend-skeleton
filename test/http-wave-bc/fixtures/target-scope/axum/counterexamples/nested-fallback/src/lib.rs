use axum::{http::StatusCode, routing::get, Router};

async fn user() -> &'static str { "user" }

pub fn app() -> Router {
    let api = Router::new()
        .route("/users", get(user))
        .fallback(|| async { StatusCode::GONE });
    Router::new()
        .nest("/api", api)
        .fallback(|| async { StatusCode::NOT_FOUND })
}
