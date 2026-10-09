from sqlmodel import Field, SQLModel


class Team(SQLModel, table=True):
    __tablename__ = "teams"

    id: int | None = Field(default=None, primary_key=True)
    name: str


class Hero(SQLModel, table=True):
    __tablename__ = "heroes"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    nickname: str
