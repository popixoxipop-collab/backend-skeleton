from litestar import Litestar, get


@get("/ping")
async def ping() -> str:
    return "pong"


app = Litestar(route_handlers=[ping])

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, root_path="/svc")
