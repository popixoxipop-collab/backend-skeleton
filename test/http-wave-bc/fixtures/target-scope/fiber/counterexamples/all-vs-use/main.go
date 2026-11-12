package allvsuse

import "github.com/gofiber/fiber/v3"

func ok(c fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) }

func NewApp() *fiber.App {
	app := fiber.New()
	app.All("/ping", ok)
	app.Use("/ping", func(c fiber.Ctx) error { return c.Next() })
	app.Get("/ping/detail", ok)
	return app
}
