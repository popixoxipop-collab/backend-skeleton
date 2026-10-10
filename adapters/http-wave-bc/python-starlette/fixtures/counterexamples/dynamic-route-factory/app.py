from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

NAMES = ["alpha", "beta"]


def make_endpoint(name):
    async def endpoint(request):
        return PlainTextResponse(name)

    return endpoint


app = Starlette(routes=[Route(f"/{name}", make_endpoint(name)) for name in NAMES])
