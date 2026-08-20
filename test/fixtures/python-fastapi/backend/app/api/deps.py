from typing import Annotated
from fastapi import Depends
from sqlmodel import Session


def get_db(): pass


SessionDep = Annotated[Session, Depends(get_db)]
