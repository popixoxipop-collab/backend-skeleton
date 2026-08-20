from sqlmodel import Field, SQLModel
import uuid


class Item(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    hashed_password: str = ""


class ItemPublic(SQLModel):
    id: uuid.UUID
