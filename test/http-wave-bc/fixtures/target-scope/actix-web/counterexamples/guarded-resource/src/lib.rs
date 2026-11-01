use actix_web::{guard, web, App, HttpResponse};

async fn allowed() -> HttpResponse { HttpResponse::Ok().finish() }
async fn denied() -> HttpResponse { HttpResponse::Forbidden().finish() }

pub fn example() {
    let _app = App::new().service(
        web::resource("/gated")
            .route(web::get().guard(guard::Header("x-token", "ok")).to(allowed))
            .route(web::get().to(denied)),
    );
}
