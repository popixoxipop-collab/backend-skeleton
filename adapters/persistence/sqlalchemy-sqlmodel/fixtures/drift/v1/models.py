from sqlmodel import Field, SQLModel


class Hero(SQLModel, table=True):
    __tablename__ = "heroes"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    secret_name: str
