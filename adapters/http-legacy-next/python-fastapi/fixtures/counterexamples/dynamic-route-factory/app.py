from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter(prefix="/dyn")
NAMES = ["alpha", "beta"]


def make_handler(name):
    def handler():
        return {"name": name}

    return handler


for name in NAMES:
    router.add_api_route(f"/{name}", make_handler(name), methods=["GET"])

app.include_router(router)
