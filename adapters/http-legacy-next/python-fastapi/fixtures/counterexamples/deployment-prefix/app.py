from fastapi import APIRouter, FastAPI

app = FastAPI(root_path="/svc")
router = APIRouter()


@router.get("/ping")
def ping():
    return "pong"


app.include_router(router)
