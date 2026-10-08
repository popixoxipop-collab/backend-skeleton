from sqlalchemy.orm import declared_attr
from sqlmodel import Field, SQLModel


class PluralBase(SQLModel):
    @declared_attr  # type: ignore[arg-type]
    def __tablename__(cls) -> str:
        return cls.__name__.lower() + "s"


class Hero(PluralBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
