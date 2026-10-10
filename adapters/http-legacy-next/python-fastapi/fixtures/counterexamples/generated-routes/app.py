from fastapi import APIRouter, FastAPI

app = FastAPI(docs_url="/api-docs", openapi_url="/api-openapi.json", redoc_url=None)
router = APIRouter()


@router.get("/ping")
def ping():
    return "pong"


app.include_router(router)
