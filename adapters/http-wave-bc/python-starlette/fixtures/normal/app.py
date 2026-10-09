from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Mount, Route


async def health(request):
    return PlainTextResponse("ok")


async def item(request):
    return PlainTextResponse(str(request.path_params["item_id"]))


routes = [
    Route("/health", health),
    Route("/items/{item_id:int}", item, methods=["GET", "DELETE"]),
    Mount("/api", routes=[Route("/ping", health)]),
]
app = Starlette(routes=routes)
