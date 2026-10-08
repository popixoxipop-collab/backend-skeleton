from django.db import models


class HeroTeamLink(models.Model):
    pk = models.CompositePrimaryKey("team_id", "hero_id")
    team_id = models.IntegerField()
    hero_id = models.IntegerField()
    joined_year = models.IntegerField()

    class Meta:
        db_table = "hero_team_links"
