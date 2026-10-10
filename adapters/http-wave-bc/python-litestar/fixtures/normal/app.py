from litestar import Litestar, Router, get, post


@get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@get("/items/{item_id:int}")
async def read_item(item_id: int) -> dict[str, int]:
    return {"id": item_id}


@post("/items")
async def create_item() -> dict[str, bool]:
    return {"created": True}


api = Router(path="/api", route_handlers=[create_item])
app = Litestar(route_handlers=[health, read_item, api])
