package middlewareorder

import "github.com/gofiber/fiber/v3"

func NewApp() *fiber.App {
	app := fiber.New()
	app.Use("/private", func(c fiber.Ctx) error {
		if c.Get("X-Token") == "" {
			return c.SendStatus(fiber.StatusUnauthorized)
		}
		return c.Next()
	})
	app.Get("/private/profile", func(c fiber.Ctx) error {
		return c.SendStatus(fiber.StatusNoContent)
	})
	return app
}
