from django.db import models


TABLE_PREFIX = "acme_"


class Hero(models.Model):
    id = models.BigAutoField(primary_key=True)
    name = models.CharField(max_length=50)

    class Meta:
        db_table = TABLE_PREFIX + "heroes"
