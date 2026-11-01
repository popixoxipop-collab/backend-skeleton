package dynamicprefix

import (
	"net/http"

	"github.com/labstack/echo/v5"
)

func NewApp(prefix string) *echo.Echo {
	e := echo.New()
	group := e.Group(prefix)
	group.GET("/records", func(c *echo.Context) error {
		return c.NoContent(http.StatusNoContent)
	})
	return e
}
