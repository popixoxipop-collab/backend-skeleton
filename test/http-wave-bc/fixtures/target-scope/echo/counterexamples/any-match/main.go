package anymatch

import (
	"net/http"

	"github.com/labstack/echo/v5"
)

func ok(c *echo.Context) error { return c.NoContent(http.StatusNoContent) }

func NewApp() *echo.Echo {
	e := echo.New()
	e.Any("/ping", ok)
	e.Match([]string{http.MethodGet, http.MethodPost}, "/form", ok)
	return e
}
