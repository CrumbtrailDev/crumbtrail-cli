# Capture Python backend evidence

Requires Python 3.9 or later. Package version 0.1.0 is source available and pending publication. Build and install the wheel locally until a release is available:

```sh
python -m pip install build
python -m build packages/python
python -m pip install packages/python/dist/crumbtrail_python-0.1.0-py3-none-any.whl
```

Configure `CRUMBTRAIL_ENDPOINT` with the HTTPS Crumbtrail origin and `CRUMBTRAIL_INGEST_KEY` with the project's backend ingest key. A loopback origin such as `http://localhost:19890` may use plain HTTP so the package can point at a local stack. Every other origin must be HTTPS.

When the configuration is missing or unusable the client does not raise. It logs one warning on the `crumbtrail` logger, disables capture, and returns the application unchanged, so a client built at module scope cannot crash the host at import.

A client may be built before the server forks its workers. The package rebuilds its queue, its worker thread and its locks in each child, so `gunicorn --preload`, uwsgi with a master process, and a client created at module scope in `wsgi.py` all capture normally. Evidence produced in a process the sender was never rebuilt for is dropped, and the first such drop logs a warning.

Capture is disabled for every route unless `should_capture` explicitly selects it. Requests must include valid `x-crumbtrail-session-id` and `x-crumbtrail-request-id` headers from an existing browser session.

```python
from crumbtrail import Client

client = Client(
    service="orders-api",
    should_capture=lambda path: path.startswith("/api/") and not path.startswith("/api/auth"),
)
```

## Flask

Register before serving requests:

```python
from flask import Flask
from crumbtrail.flask import install

app = Flask(__name__)
install(app, client)
```

## FastAPI and other ASGI applications

```python
from fastapi import FastAPI
from crumbtrail import ASGIMiddleware

app = FastAPI()
app.add_middleware(ASGIMiddleware, client=client)
```

Non HTTP scopes pass through. FastAPI route templates are retained. Generic ASGI integrations without a route object report `/` to avoid exporting path parameters. SQLAlchemy instrumentation also works with FastAPI synchronous handlers because context is propagated to its thread pool.

## Django WSGI

In `wsgi.py`, wrap the application returned by Django:

```python
from django.core.wsgi import get_wsgi_application
from crumbtrail.django import wrap_wsgi

application = wrap_wsgi(get_wsgi_application(), client)
```

The wrapper captures queries on configured Django database connections throughout response iteration. This Django database adapter supports synchronous WSGI. For Django ASGI, the generic `ASGIMiddleware` provides request evidence but does not instrument Django's separate synchronous database threads.

## SQLAlchemy

Register once on an engine. For an asynchronous engine, pass its `sync_engine`:

```python
from sqlalchemy import create_engine
from crumbtrail.database import instrument_sqlalchemy

engine = create_engine("sqlite://")
uninstall = instrument_sqlalchemy(engine)
```

The maintained adapter records query operation, duration, row count when available, and error type. It never captures SQL text, parameters, row values, connection strings or exception messages. `shape` is explicitly `[statement omitted]`, and `rowEvidence` is `not_captured`. Row diffs and transaction state capture are not implemented. Call `uninstall()` when disposing instrumentation.

## Verify and shut down

Exercise an eligible JSON route with browser correlation headers. The existing session should contain `backend.req.start`, `backend.req.end` and any instrumented `db.statement` or `db.error` events. This package appends to existing sessions. It does not create browser sessions.

Call `client.close(timeout=5)` from the server's worker shutdown hook. It stops accepting evidence and waits up to five seconds for queued delivery. It returns `False` if work remains. ASGI lifecycle scopes pass through, so register your shutdown hook explicitly. A hook registered with `atexit` flushes queued evidence for up to two seconds at interpreter exit, which covers an ordinary shutdown but not a signal that kills the process outright.

The background worker uses a queue of 64 batches, each containing at most 20 events. A request retains at most 198 intermediate events and emits a capture gap when that limit is exceeded. Delivery retries 429, server failures and network failures up to four attempts with five second request timeouts, and honours a `Retry-After` header on 429 up to 30 seconds. A 404 means the session does not belong to this ingest key, which no retry changes, so it is not retried. Redirects are disabled. Other rejection statuses are not retried. `client.sink.dropped` and `client.sink.failed` report overflow or failed delivery counts when using the default sender. Capture failures do not change application response bytes or exceptions, including when an application breaks the WSGI contract by passing a malformed status line or yielding `str` instead of `bytes`. A failure after response transmission begins records `backend.req.error` and retains the emitted HTTP status.

JSON request and response bodies retain at most 16 KiB each. The conservative profile exports numbers, booleans, null, short lowercase enums and three letter uppercase units. It also exports object key names verbatim. Read that plainly: a numeric value under a key the profile does not recognise as sensitive leaves your process, so `{"salary":185000}` is exported in full, and so is every key name in the body. Values under keys matching the sensitive list, including location keys such as `lat`, `lng` and `latitude`, are replaced with `[REDACTED]`, as is every other string.

Object keys must match `[a-zA-Z_][a-zA-Z0-9_.-]{0,63}`, so hyphens and dots are accepted. Duplicate keys, keys outside that pattern, more than 64 keys in one object, depth beyond 8 and arrays longer than 40 elements are not exported. Bodies have explicit `captured`, `redacted`, `missing`, `invalid` or `truncated` states. A body the profile will not export reports `invalid` whether the JSON was malformed or merely an unsupported shape, because the analysis pipeline accepts no other state. The `crumbtrail` logger records which of the two it was at debug level. Bodies the application does not fully read are marked truncated. Request capture never pre reads a stream. Response streaming remains incremental. A JSON request or response whose observed byte count differs from its declared `Content-Length` is marked truncated even if its stream ends normally. Malformed length declarations also prevent claiming complete body evidence. HEAD responses and statuses that do not carry a response body report missing body evidence. Query strings, headers, raw path parameters and exception messages are not exported.

## Diagnostics

The package logs on the `crumbtrail` logger and never raises into the host application. Failures inside capture are logged at debug. Capture being disabled, a batch dropped after every delivery attempt, an ingest rejection, and evidence produced in a process the sender was not rebuilt for are logged at warning.

```python
import logging

logging.getLogger("crumbtrail").setLevel(logging.DEBUG)
```

## Run package tests

```sh
python -m pip install -e 'packages/python[test]'
python -m pytest packages/python/tests
```
