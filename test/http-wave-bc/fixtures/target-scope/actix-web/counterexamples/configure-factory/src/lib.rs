use actix_web::{web, App, HttpResponse};

async fn hidden() -> HttpResponse { HttpResponse::Ok().finish() }

fn install_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/hidden", web::get().to(hidden));
}

// Registration happens inside a configuration function, not a literal App.route call.
pub fn example() {
    let _app = App::new().configure(install_routes);
}
