"""Offline oracle for the sqlalchemy-sqlmodel scope record.

Imports one fixture models module and prints, as JSON on stdout, the physical schema facts
(tables, columns, primary keys, foreign keys) of every SQLAlchemy MetaData that module fills,
plus the versions of the libraries that produced them. No database connection is opened.
"""
import hashlib
import importlib.metadata as metadata
import importlib.util
import json
import os
import platform
import sys

from sqlalchemy import CheckConstraint, MetaData, UniqueConstraint
from sqlalchemy.orm import Session
from sqlmodel import SQLModel

sys.dont_write_bytecode = True  # keep the committed fixture directories free of __pycache__


def digests(*names):
    """sha256 of every file this run consumes (this script and the fixture file), keyed by its path relative to the working directory."""
    found = {}
    for name in names:
        with open(name, "rb") as handle:
            found[os.path.relpath(name).replace(os.sep, "/")] = hashlib.sha256(handle.read()).hexdigest()
    return found


def load(path):
    spec = importlib.util.spec_from_file_location("fixture_models", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["fixture_models"] = module
    spec.loader.exec_module(module)
    return module


def metadatas(module):
    found = [SQLModel.metadata]
    for value in vars(module).values():
        meta = getattr(value, "metadata", None)
        if isinstance(meta, MetaData) and not any(meta is known for known in found):
            found.append(meta)
    return found


def facts(metas):
    tables, columns, primary_keys, foreign_keys, unmodeled = set(), set(), set(), set(), set()
    for meta in metas:
        if meta.naming_convention != MetaData().naming_convention:
            unmodeled.add("constraint-naming-convention")
        for table in meta.tables.values():
            name = table.name if table.schema is None else f"{table.schema}.{table.name}"
            tables.add(name)
            columns.update(f"{name}.{column.name}" for column in table.columns)
            if table.primary_key.columns:
                primary_keys.add(f"{name}({','.join(column.name for column in table.primary_key.columns)})")
            for constraint in table.foreign_key_constraints:
                local = ",".join(element.parent.name for element in constraint.elements)
                remote = ",".join(element.column.name for element in constraint.elements)
                parent = constraint.referred_table
                parent_name = parent.name if parent.schema is None else f"{parent.schema}.{parent.name}"
                foreign_keys.add(f"{name}({local})->{parent_name}({remote})")
            if table.indexes:
                unmodeled.add("create-index")
            if any(isinstance(item, UniqueConstraint) for item in table.constraints):
                unmodeled.add("unique-constraint")
            if any(isinstance(item, CheckConstraint) for item in table.constraints):
                unmodeled.add("check-constraint")
    if len(Session().dispatch.do_orm_execute) > 0:
        unmodeled.add("session-event:do_orm_execute")
    return {
        "tables": sorted(tables),
        "columns": sorted(columns),
        "primary_keys": sorted(primary_keys),
        "foreign_keys": sorted(foreign_keys),
        "unmodeled": sorted(unmodeled),
    }


def main(path):
    consumed = digests(__file__, path)  # before the fixture is imported
    module = load(path)
    result = {
        "inputs": consumed,
        "oracle": "sqlalchemy-metadata",
        "versions": {
            "python": platform.python_version(),
            "SQLAlchemy": metadata.version("SQLAlchemy"),
            "sqlmodel": metadata.version("sqlmodel"),
            "pydantic": metadata.version("pydantic"),
        },
        "facts": facts(metadatas(module)),
    }
    sys.stdout.write(json.dumps(result, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
