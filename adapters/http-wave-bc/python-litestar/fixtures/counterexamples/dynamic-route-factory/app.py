from litestar import Litestar, get

NAMES = ["alpha", "beta"]


def make_handler(name):
    @get(f"/{name}", name=name)
    async def handler() -> str:
        return name

    return handler


app = Litestar(route_handlers=[make_handler(name) for name in NAMES])
