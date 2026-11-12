use actix_web::{web, App, HttpResponse};

async fn user() -> HttpResponse { HttpResponse::Ok().finish() }

// The prefix is bound by a caller; a static extractor must not invent it.
pub fn example(prefix: &str) {
    let _app = App::new().service(
        web::scope(prefix).route("/users/{id}", web::get().to(user)),
    );
}
