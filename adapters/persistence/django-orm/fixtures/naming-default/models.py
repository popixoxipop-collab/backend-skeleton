from django.db import models


class Hero(models.Model):
    id = models.BigAutoField(primary_key=True)
    name = models.CharField(max_length=50)


class OrderItem(models.Model):
    id = models.BigAutoField(primary_key=True)
    sku = models.CharField(max_length=50)
