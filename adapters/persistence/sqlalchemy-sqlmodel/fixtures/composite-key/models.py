from sqlmodel import Field, SQLModel


class HeroTeamLink(SQLModel, table=True):
    __tablename__ = "hero_team_links"

    team_id: int = Field(primary_key=True)
    hero_id: int = Field(primary_key=True)
    joined_year: int
