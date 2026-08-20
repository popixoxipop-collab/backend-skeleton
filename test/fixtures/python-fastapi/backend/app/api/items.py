from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/{id}", response_model=ItemPublic)
def read_item(session: SessionDep, id: str):
    pass
