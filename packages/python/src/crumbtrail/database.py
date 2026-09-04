"""Query metadata without SQL text, parameters, result rows or exception messages."""
import re
import time
from .core import current_capture, now


def _record(capture, sql, engine, start, rows=None, error=None):
    if capture is None:
        return
    try:
        # Only a leading SQL operation is retained. Arbitrary dialect literals cannot leak.
        first = re.match(r"\s*(select|insert|update|delete)\b", sql[:64], re.I)
        operation = first.group(1).lower() if first else "other"
        capture.sequence += 1
        payload = {"engine": engine, "op": operation, "table": None, "shape": "[statement omitted]", "requestId": capture.request, "t": now(), "durationMs": (time.monotonic() - start) * 1000, "seq": capture.sequence}
        if error is None:
            payload.update(rowCount=rows if isinstance(rows, int) and rows >= 0 else None, rowEvidence="not_captured")
        else:
            payload.update(code=None, category="unknown", errorName=type(error).__name__)
        capture.add("db.error" if error else "db.statement", payload)
    except Exception:
        pass


def instrument_sqlalchemy(engine):
    """Register on a SQLAlchemy 2.x Engine (or AsyncEngine.sync_engine). Returns uninstall."""
    from sqlalchemy import event
    if getattr(engine, "_crumbtrail_uninstall", None):
        return engine._crumbtrail_uninstall
    engine_name = {"postgresql": "postgres", "sqlite": "sqlite", "mysql": "mysql"}.get(engine.dialect.name, "unknown")

    def before(conn, cursor, statement, parameters, context, executemany):
        context._crumbtrail = (current_capture.get(), time.monotonic())

    def after(conn, cursor, statement, parameters, context, executemany):
        capture, start = getattr(context, "_crumbtrail", (None, 0))
        _record(capture, statement, engine_name, start, cursor.rowcount)

    def error(context):
        execution = context.execution_context
        capture, start = getattr(execution, "_crumbtrail", (None, 0))
        _record(capture, context.statement or "", engine_name, start, error=context.original_exception)

    listeners = [("before_cursor_execute", before), ("after_cursor_execute", after), ("handle_error", error)]
    for name, fn in listeners:
        event.listen(engine, name, fn)

    def uninstall():
        for name, fn in listeners:
            if event.contains(engine, name, fn):
                event.remove(engine, name, fn)
        if getattr(engine, "_crumbtrail_uninstall", None) is uninstall:
            del engine._crumbtrail_uninstall
    engine._crumbtrail_uninstall = uninstall
    return uninstall


def django_execute(execute, sql, params, many, context):
    capture = current_capture.get()
    started = time.monotonic()
    error = None
    try:
        return execute(sql, params, many, context)
    except BaseException as failure:
        error = failure
        raise
    finally:
        vendor = context["connection"].vendor
        engine = {"postgresql": "postgres", "sqlite": "sqlite", "mysql": "mysql"}.get(vendor, "unknown")
        _record(capture, sql, engine, started, getattr(context["cursor"], "rowcount", None), error)
