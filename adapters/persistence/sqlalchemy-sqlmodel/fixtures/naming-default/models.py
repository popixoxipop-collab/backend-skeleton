from sqlmodel import Field, SQLModel


class Hero(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str


class OrderItem(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    sku: str
