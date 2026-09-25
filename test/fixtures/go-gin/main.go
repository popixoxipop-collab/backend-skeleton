package main

import "github.com/gin-gonic/gin"

func main() {
    router := gin.Default()
    router.GET("/health", health)
    api := router.Group("/api")
    api.GET("/users/:id", showUser)
}
