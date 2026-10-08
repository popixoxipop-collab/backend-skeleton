from sqlalchemy import event
from sqlalchemy.orm import Session, with_loader_criteria
from sqlmodel import Field, SQLModel

CURRENT_TENANT = 1


class Invoice(SQLModel, table=True):
    __tablename__ = "invoices"

    id: int | None = Field(default=None, primary_key=True)
    tenant_id: int = Field(index=True)
    total_cents: int


@event.listens_for(Session, "do_orm_execute")
def apply_tenant_scope(execute_state):
    if execute_state.is_select:
        execute_state.statement = execute_state.statement.options(
            with_loader_criteria(Invoice, lambda cls: cls.tenant_id == CURRENT_TENANT, include_aliases=True)
        )
