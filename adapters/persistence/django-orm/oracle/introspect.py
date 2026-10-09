"""Offline oracle for the django-orm scope record.

Registers one fixture models.py as the app "shop" in a Django app registry configured without any database, and prints, as JSON
on stdout, the physical schema facts (tables, columns, primary keys, foreign keys) Django derives from the model classes,
plus the versions of the libraries that produced them. No database connection is opened.
"""
import hashlib
import importlib.metadata as metadata
import json
import os
import platform
import sys
import types

import django
from django.conf import settings

sys.dont_write_bytecode = True  # keep the committed fixture directories free of __pycache__


def digests(*names):
    """sha256 of every file this run consumes (this script and the fixture file), keyed by its path relative to the working directory."""
    found = {}
    for name in names:
        with open(name, "rb") as handle:
            found[os.path.relpath(name).replace(os.sep, "/")] = hashlib.sha256(handle.read()).hexdigest()
    return found


def configure(path):
    package = types.ModuleType("shop")
    package.__path__ = [os.path.dirname(os.path.abspath(path))]
    sys.modules["shop"] = package
    settings.configure(INSTALLED_APPS=["shop"], DATABASES={}, DEFAULT_AUTO_FIELD="django.db.models.BigAutoField", USE_TZ=True)
    django.setup()


def facts():
    from django.apps import apps
    from django.db import models

    tables, columns, primary_keys, foreign_keys, unmodeled = set(), set(), set(), set(), set()
    for model in apps.get_models():
        meta = model._meta
        table = meta.db_table
        tables.add(table)
        columns.update(f"{table}.{field.column}" for field in meta.concrete_fields)
        pk = meta.pk
        pk_columns = list(pk.columns) if isinstance(pk, models.CompositePrimaryKey) else [pk.column]
        primary_keys.add(f"{table}({','.join(pk_columns)})")
        for field in meta.concrete_fields:
            if field.remote_field is not None:
                foreign_keys.add(f"{table}({field.column})->{field.related_model._meta.db_table}({field.target_field.column})")
            elif field.db_index:
                unmodeled.add("create-index")
            if field.unique and not field.primary_key:
                unmodeled.add("unique-constraint")
        if meta.indexes:
            unmodeled.add("create-index")
        if meta.unique_together or any(isinstance(item, models.UniqueConstraint) for item in meta.constraints):
            unmodeled.add("unique-constraint")
        if any(isinstance(item, models.CheckConstraint) for item in meta.constraints):
            unmodeled.add("check-constraint")
        if type(model._default_manager) is not models.Manager:
            unmodeled.add("custom-default-manager")
    return {
        "tables": sorted(tables),
        "columns": sorted(columns),
        "primary_keys": sorted(primary_keys),
        "foreign_keys": sorted(foreign_keys),
        "unmodeled": sorted(unmodeled),
    }


def main(path):
    consumed = digests(__file__, path)  # before the fixture is imported
    configure(path)
    result = {
        "inputs": consumed,
        "oracle": "django-app-registry",
        "versions": {"python": platform.python_version(), "Django": metadata.version("Django")},
        "facts": facts(),
    }
    sys.stdout.write(json.dumps(result, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
