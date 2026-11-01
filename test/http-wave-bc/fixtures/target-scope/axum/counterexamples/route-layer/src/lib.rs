use axum::{http::StatusCode, middleware::{from_fn, Next}, response::{IntoResponse, Response}, routing::get, extract::Request, Router};

async fn health() -> &'static str { "ok" }
async fn late() -> &'static str { "late" }

async fn guard(req: Request, next: Next) -> Response {
    if req.headers().get("x-token").is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(req).await
}

pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .route_layer(from_fn(guard))
        .route("/late", get(late))
}
