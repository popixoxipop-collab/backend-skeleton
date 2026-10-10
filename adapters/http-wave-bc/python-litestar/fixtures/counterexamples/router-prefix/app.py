from litestar import Litestar, Router, get


@get("/ping")
async def ping() -> str:
    return "pong"


inner = Router(path="/v1", route_handlers=[ping])
outer = Router(path="/api", route_handlers=[inner])
app = Litestar(route_handlers=[outer], path="/svc")
