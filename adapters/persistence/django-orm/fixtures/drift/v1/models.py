from django.db import models


class Hero(models.Model):
    id = models.BigAutoField(primary_key=True)
    name = models.CharField(max_length=50)
    secret_name = models.CharField(max_length=50)

    class Meta:
        db_table = "heroes"
