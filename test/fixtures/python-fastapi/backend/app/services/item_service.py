"""P3b/G4 follow-up fixture: a hand-written (not generated) service function pre-decorated with
`@record_snapshot`, mirroring java-spring's own O4 fixture precedent (WidgetServiceImpl in
test/fixtures/java-compile/) -- codegen never writes this file, a human applies the decorator to
their own existing code. Exercised by scripts/python-integration-smoke.mjs.
"""
import uuid

from sqlmodel import Session

from app.handles.record_snapshot import record_snapshot
from app.models import Item


@record_snapshot(
    resource_type="Item",
    operation_id="update_item",
    resource_uid_param="item_id",
    session_param="session",
    redact=["/internal_note"],
)
def update_item(session: Session, item_id: uuid.UUID, updates: dict) -> Item:
    """`updates` is a plain dict (a real request DTO's own .model_dump() shape, in a real app) --
    deliberately not a bare `title: str` parameter, so the RECORDED REQUEST envelope actually
    carries `internal_note` for @record_snapshot's own `redact=["/internal_note"]` to have
    something real to blank before storage.
    """
    item = session.get(Item, item_id)
    item.title = updates["title"]
    if "internal_note" in updates:
        item.internal_note = updates["internal_note"]
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


# D-runtime-conformance-receipts (async-wrapper fix): an `async def` twin of update_item(), same
# body, same @record_snapshot config (own operationId so it registers a distinct handle) --
# FastAPI service methods are commonly async, and record_snapshot.py's decorator originally had no
# async-aware wrapper (observe_contract.py's sibling decorator already did). Exercised by
# scripts/python-integration-smoke.mjs's own async scenario, proving the fix against a real
# asyncio.run() call, not just a static template read.
@record_snapshot(
    resource_type="Item",
    operation_id="update_item_async",
    resource_uid_param="item_id",
    session_param="session",
    redact=["/internal_note"],
)
async def update_item_async(session: Session, item_id: uuid.UUID, updates: dict) -> Item:
    item = session.get(Item, item_id)
    item.title = updates["title"]
    if "internal_note" in updates:
        item.internal_note = updates["internal_note"]
    session.add(item)
    session.commit()
    session.refresh(item)
    return item
