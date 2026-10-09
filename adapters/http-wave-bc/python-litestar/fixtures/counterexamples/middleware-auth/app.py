from litestar import Litestar, get
from litestar.connection import ASGIConnection
from litestar.exceptions import NotAuthorizedException
from litestar.handlers.base import BaseRouteHandler


def require_token(connection: ASGIConnection, _: BaseRouteHandler) -> None:
    if connection.headers.get("authorization") is None:
        raise NotAuthorizedException()


@get("/public")
async def public() -> str:
    return "public"


@get("/private", guards=[require_token])
async def private() -> str:
    return "private"


app = Litestar(route_handlers=[public, private])
