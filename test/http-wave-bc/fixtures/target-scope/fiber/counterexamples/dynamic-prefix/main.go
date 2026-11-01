package dynamicprefix

import "github.com/gofiber/fiber/v3"

func NewApp(prefix string) *fiber.App {
	app := fiber.New()
	group := app.Group(prefix)
	group.Get("/records", func(c fiber.Ctx) error {
		return c.SendStatus(fiber.StatusNoContent)
	})
	return app
}
