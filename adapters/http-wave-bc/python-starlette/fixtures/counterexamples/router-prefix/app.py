from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Mount, Route


async def ping(request):
    return PlainTextResponse("pong")


app = Starlette(routes=[Mount("/api", routes=[Mount("/v1", routes=[Route("/ping", ping)])])])
