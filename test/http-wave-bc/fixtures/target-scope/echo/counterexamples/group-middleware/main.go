package groupmiddleware

import (
	"net/http"

	"github.com/labstack/echo/v5"
)

func requireToken(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		if c.Request().Header.Get("X-Token") == "" {
			return c.NoContent(http.StatusUnauthorized)
		}
		return next(c)
	}
}

func NewApp() *echo.Echo {
	e := echo.New()
	private := e.Group("/private", requireToken)
	private.GET("/profile", func(c *echo.Context) error {
		return c.NoContent(http.StatusNoContent)
	})
	return e
}
