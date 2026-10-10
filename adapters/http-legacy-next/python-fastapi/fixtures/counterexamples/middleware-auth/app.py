from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException

app = FastAPI()


def require_token(authorization: str = Header(default=None)):
    if authorization is None:
        raise HTTPException(status_code=401)


router = APIRouter(prefix="/private", dependencies=[Depends(require_token)])


@router.get("/data")
def data():
    return {"data": 1}


app.include_router(router)
