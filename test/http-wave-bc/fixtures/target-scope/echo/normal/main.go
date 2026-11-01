package normal

import (
	"net/http"

	"github.com/labstack/echo/v5"
)

func ok(c *echo.Context) error { return c.NoContent(http.StatusNoContent) }

func NewApp() *echo.Echo {
	e := echo.New()
	e.GET("/health", ok)
	api := e.Group("/api")
	api.GET("/users/:id", ok)
	api.POST("/users", ok)
	return e
}
