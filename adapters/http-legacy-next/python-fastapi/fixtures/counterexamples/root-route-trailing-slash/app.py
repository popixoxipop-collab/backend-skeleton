from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter(prefix="/items")


@router.get("/")
def list_items():
    return []


app.include_router(router)
