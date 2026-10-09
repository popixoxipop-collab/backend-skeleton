from django.db import models


CURRENT_TENANT = 1


class TenantManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(tenant_id=CURRENT_TENANT)


class Invoice(models.Model):
    id = models.BigAutoField(primary_key=True)
    tenant_id = models.IntegerField(db_index=True)
    total_cents = models.IntegerField()

    objects = TenantManager()

    class Meta:
        db_table = "invoices"
