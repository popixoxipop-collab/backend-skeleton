from litestar import Litestar, get
from litestar.openapi import OpenAPIConfig


@get("/ping")
async def ping() -> str:
    return "pong"


app = Litestar(route_handlers=[ping], openapi_config=OpenAPIConfig(title="scope", version="1", path="/docs"))
