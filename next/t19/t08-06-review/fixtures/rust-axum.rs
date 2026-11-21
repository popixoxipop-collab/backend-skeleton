fn routes() {
 let notices = Router::new().route("/inbox", post(create_notice));
 let raw = r#"Router::new().route("/phantom", get(fake))"#;
 let app = Router::new().nest("/api", notices).route("/healthz", get(health));
 let shadow = app.clone().route("/hidden", get(hidden));
}
