from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter(prefix="/items", tags=["items"])


@router.get("/{item_id}")
def read_item(item_id: int):
    return {"id": item_id}


@router.post("/create")
def create_item():
    return {"created": True}


app.include_router(router)
