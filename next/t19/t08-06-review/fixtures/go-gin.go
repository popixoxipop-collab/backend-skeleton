package main
func routes() {
 engine := gin.New()
 metrics := engine.Group("/metrics")
 // engine.DELETE("/phantom", fake)
 metrics.GET("/live", live)
 metrics.PUT(base + "/config", update)
}
