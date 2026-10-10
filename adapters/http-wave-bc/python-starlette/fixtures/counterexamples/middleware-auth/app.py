from starlette.applications import Starlette
from starlette.authentication import AuthenticationBackend, requires
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.responses import PlainTextResponse
from starlette.routing import Route


class Backend(AuthenticationBackend):
    async def authenticate(self, conn):
        return None


async def public(request):
    return PlainTextResponse("public")


@requires("authenticated")
async def private(request):
    return PlainTextResponse("private")


app = Starlette(
    routes=[Route("/public", public), Route("/private", private)],
    middleware=[Middleware(AuthenticationMiddleware, backend=Backend())],
)
