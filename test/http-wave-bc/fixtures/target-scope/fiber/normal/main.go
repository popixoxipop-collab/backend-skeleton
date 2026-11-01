package normal

import "github.com/gofiber/fiber/v3"

func ok(c fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) }

func NewApp() *fiber.App {
	app := fiber.New()
	app.Get("/health", ok)
	api := app.Group("/api")
	api.Get("/users/:id", ok)
	api.Post("/users", ok)
	return app
}
