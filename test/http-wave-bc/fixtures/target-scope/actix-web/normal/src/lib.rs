use actix_web::{web, App, HttpResponse};

async fn health() -> HttpResponse { HttpResponse::Ok().finish() }
async fn user() -> HttpResponse { HttpResponse::Ok().finish() }
async fn create_user() -> HttpResponse { HttpResponse::Created().finish() }

pub fn example() {
    let _app = App::new()
        .route("/health", web::get().to(health))
        .service(
            web::scope("/api")
                .route("/users/{id}", web::get().to(user))
                .route("/users", web::post().to(create_user)),
        );
}
