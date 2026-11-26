fn routes() {
 let app = App::new()
  .service(web::scope("/v2").route("/events", web::put().to(update)))
  // .route("/phantom", web::get().to(fake))
  .route(dynamic_path(), web::get().to(find));
}
