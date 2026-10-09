from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles


async def ping(request):
    return PlainTextResponse("pong")


app = Starlette(
    routes=[
        Route("/ping", ping),
        Mount("/static", app=StaticFiles(directory="static", check_dir=False), name="static"),
    ]
)
