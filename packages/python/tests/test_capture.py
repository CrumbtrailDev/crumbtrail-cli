import asyncio
import io
import json
import os

import pytest
from crumbtrail import Client, ASGIMiddleware, WSGIMiddleware
from crumbtrail.core import current_capture
from crumbtrail.privacy import capture_body

HEADERS = {"x-crumbtrail-session-id": "python-session", "x-crumbtrail-request-id": "python-request"}


class Sink:
    def __init__(self):
        self.batches = []

    def enqueue(self, batch):
        self.batches.append(batch)

    @property
    def events(self):
        return [e for b in self.batches for e in b["events"]]


@pytest.fixture
def capture():
    sink = Sink()
    return Client(sink=sink, should_capture=lambda path: path.startswith("/api/")), sink


@pytest.mark.parametrize("raw,state", [
    (b'', 'missing'), (b'{', 'invalid'), (b'{"amount":18.75,"currency":"CAD"}', 'captured'),
    (b'{"password":"secret","amount":18.75}', 'redacted'),
    (b'{"amount":1,"amount":2}', 'invalid'), (b'{"bad.key":1}', 'invalid'),
    (b'{"value":NaN}', 'invalid'), (b'[' * 1000, 'invalid'),
    (b'x' * 16385, 'truncated'), (json.dumps([1] * 41).encode(), 'invalid'),
    (b'{"accountNumber":1234}', 'redacted'), (b'{"value":4111111111111111}', 'redacted'), (b'{"value":4111111111111111.0}', 'redacted'),
])
def test_profile(raw, state):
    assert capture_body(raw)[1] == state


def test_flask_request_database_and_response(capture, tmp_path):
    from flask import Flask, request, jsonify
    from crumbtrail.flask import install
    from crumbtrail.database import instrument_sqlalchemy
    from sqlalchemy import create_engine, text
    client, sink = capture
    engine = create_engine("sqlite://")
    uninstall = instrument_sqlalchemy(engine)
    assert instrument_sqlalchemy(engine) is uninstall
    app = Flask(__name__)
    install(app, client)
    install(app, client)

    @app.post('/api/orders/<int:order_id>')
    def orders(order_id):
        body = request.get_json()
        with engine.connect() as connection:
            assert connection.execute(text("select :secret"), {"secret": "private sql operand"}).scalar() == "private sql operand"
        return jsonify(amount=body["amount"] * 2, currency="CAD", token="hidden response")

    response = app.test_client().post('/api/orders/731?password=hidden', json={"amount": 18.75, "currency": "CAD", "orderId": 731, "password": "never-transmit", "email": "a@example.com", "card": "4111111111111111"}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json == {"amount": 37.5, "currency": "CAD", "token": "hidden response"}
    events = sink.events
    assert [e['k'] for e in events] == ['backend.req.start', 'db.statement', 'backend.req.end']
    assert events[0]['d']['route'] == '/api/orders/<int:order_id>'
    assert json.loads(events[0]['d']['body'])['amount'] == 18.75
    assert json.loads(events[-1]['d']['responseBody'])['amount'] == 37.5
    assert events[1]['d']['shape'] == '[statement omitted]'
    assert 'hidden' not in json.dumps(events)
    assert 'private sql operand' not in json.dumps(events)
    assert current_capture.get() is None
    uninstall()
    uninstall()
    output = os.environ.get("CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT")
    if output:
        with open(output, 'w') as f:
            json.dump({"sessionId": "python-session", "events": events}, f)


def test_fastapi_real_request(capture):
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient
    client, sink = capture
    app = FastAPI()
    app.add_middleware(ASGIMiddleware, client=client)

    @app.post('/api/orders/{order_id}')
    async def orders(order_id: int, request: Request):
        return {"amount": (await request.json())["amount"] * 2, "orderId": order_id}

    with TestClient(app) as http:
        response = http.post('/api/orders/731', json={"amount": 18.75}, headers=HEADERS)
    assert response.json() == {"amount": 37.5, "orderId": 731}
    assert sink.events[0]['d']['route'] == '/api/orders/{order_id}'
    assert sink.events[-1]['d']['responseBodyState'] == 'captured'
    assert current_capture.get() is None


def test_wsgi_streaming_input_output_and_close(capture):
    client, sink = capture
    chunks = [b'{"amount":', b'18.75}']
    closed = []

    def app(environ, start_response):
        assert environ['wsgi.input'].read(3) == b'{"a'
        buffer = bytearray(13)
        count = environ['wsgi.input'].readinto(buffer)
        assert b'{"a' + buffer[:count] == b'{"amount":18.75}'
        start_response('200 OK', [('Content-Type', 'application/json')])
        try:
            yield from chunks
        finally:
            closed.append(True)

    environ = {'PATH_INFO': '/api/a', 'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': 'application/json', 'CONTENT_LENGTH': '16', 'wsgi.input': io.BytesIO(b'{"amount":18.75}'), 'HTTP_X_CRUMBTRAIL_SESSION_ID': 's', 'HTTP_X_CRUMBTRAIL_REQUEST_ID': 'r'}
    environ['CONTENT_LENGTH'] = str(len(b'{"amount":18.75}'))
    response = WSGIMiddleware(app, client)(environ, lambda *args: None)
    assert next(response) == chunks[0]
    assert sink.events == []
    assert next(response) == chunks[1]
    with pytest.raises(StopIteration):
        next(response)
    response.close()
    assert len(closed) == 1
    assert sink.events[-1]['d']['responseBodyState'] == 'captured'
    assert sink.events[0]['d']['requestBodyState'] == 'captured'


def test_asgi_preserves_messages_errors_and_context(capture):
    client, sink = capture
    messages = [{"type": "http.request", "body": b'{"a":', "more_body": True}, {"type": "http.request", "body": b'1}', "more_body": False}]
    sent = []
    marker = RuntimeError('secret error text')

    async def app(scope, receive, send):
        assert await receive() is messages[0]
        assert await receive() is messages[1]
        await send({"type": "http.response.start", "status": 200, "headers": [(b'content-type', b'application/json')]})
        await send({"type": "http.response.body", "body": b'{', "more_body": True})
        raise marker

    async def run():
        iterator = iter(messages)
        async def receive():
            return next(iterator)
        async def send(message):
            sent.append(message)
        scope = {"type": "http", "path": "/api/a", "headers": [(k.encode(), v.encode()) for k, v in dict(HEADERS, **{"content-type": "application/json"}).items()]}
        with pytest.raises(RuntimeError) as error:
            await ASGIMiddleware(app, client)(scope, receive, send)
        assert error.value is marker
        assert current_capture.get() is None
    asyncio.run(run())
    assert len(sent) == 2
    assert sink.events[-1]['d']['responseBodyState'] == 'truncated'
    assert sink.events[-1]['d']['statusCode'] == 200
    assert any(e['k'] == 'backend.req.error' for e in sink.events)
    assert 'secret error text' not in json.dumps(sink.events)


def test_default_disabled_and_unlinked_requests():
    from flask import Flask
    from crumbtrail.flask import install
    sink = Sink()
    app = Flask(__name__)
    install(app, Client(sink=sink))
    app.add_url_rule('/api/a', view_func=lambda: {'amount': 1})
    assert app.test_client().get('/api/a', headers=HEADERS).status_code == 200
    assert sink.events == []


def test_sink_failure_does_not_change_response():
    from flask import Flask
    from crumbtrail.flask import install
    class Broken:
        def enqueue(self, _):
            raise RuntimeError('sink')
    app = Flask(__name__)
    install(app, Client(sink=Broken(), should_capture=lambda _: True))
    app.add_url_rule('/api/a', view_func=lambda: {'amount': 1})
    assert app.test_client().get('/api/a', headers=HEADERS).json == {'amount': 1}


def test_asgi_concurrent_requests_do_not_share_evidence(capture):
    client, sink = capture
    async def app(scope, receive, send):
        identity = scope['path'].split('/')[-1]
        await asyncio.sleep(0)
        assert current_capture.get().request == identity
        current_capture.get().add('db.statement', {'requestId': identity})
        await send({'type': 'http.response.start', 'status': 200, 'headers': []})
        await asyncio.sleep(0)
        await send({'type': 'http.response.body', 'body': b'{}'})
    async def run(identity):
        async def receive():
            return {'type': 'http.request', 'body': b''}
        async def send(message):
            pass
        scope = {'type': 'http', 'path': '/api/' + identity, 'headers': [(b'x-crumbtrail-session-id', identity.encode()), (b'x-crumbtrail-request-id', identity.encode())]}
        await ASGIMiddleware(app, client)(scope, receive, send)
        assert current_capture.get() is None
    async def main():
        await asyncio.gather(*(run(str(i)) for i in range(30)))
    asyncio.run(main())
    assert len(sink.batches) == 30
    for batch in sink.batches:
        assert all(e['d']['requestId'] == batch['sessionId'] for e in batch['events'])


@pytest.mark.parametrize('failure_point', ['iter', 'next'])
def test_wsgi_preserves_primary_failure_when_close_also_fails(capture, failure_point):
    client, sink = capture
    primary = RuntimeError('primary secret')
    closed = []
    class BadIterable:
        def __iter__(self):
            assert current_capture.get() is not None
            if failure_point == 'iter':
                raise primary
            return self
        def __next__(self):
            raise primary
        def close(self):
            closed.append(True)
            raise ValueError('secondary secret')
    def route(environ):
        raise ValueError('bad route callback')
    env = {'PATH_INFO': '/api/a', 'wsgi.input': io.BytesIO(), 'HTTP_X_CRUMBTRAIL_SESSION_ID': 's', 'HTTP_X_CRUMBTRAIL_REQUEST_ID': 'r'}
    response = WSGIMiddleware(lambda *args: BadIterable(), client, route)(env, lambda *args: None)
    with pytest.raises(RuntimeError) as failure:
        next(response)
    assert failure.value is primary
    assert closed == [True]
    assert sink.events[-1]['d']['statusCode'] == 500
    assert current_capture.get() is None


def test_sqlalchemy_error_is_preserved_and_redacted(capture):
    from crumbtrail.database import instrument_sqlalchemy
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import OperationalError
    from crumbtrail.core import Capture
    client, sink = capture
    engine = create_engine('sqlite://')
    uninstall = instrument_sqlalchemy(engine)
    captured = Capture('s', 'r', 'test', 'GET')
    token = current_capture.set(captured)
    try:
        with engine.connect() as connection:
            with pytest.raises(OperationalError):
                connection.execute(text('select secret_column from secret_table'))
    finally:
        current_capture.reset(token)
        uninstall()
    captured.finish(sink, '')
    assert sink.events[1]['k'] == 'db.error'
    assert 'secret_' not in json.dumps(sink.events)


@pytest.mark.parametrize('send_chunk,expected_status', [(True, 200), (False, 500)])
def test_wsgi_stream_error_retains_emitted_status(capture, send_chunk, expected_status):
    client, sink = capture
    failure = RuntimeError('stream failure')
    def app(environ, start_response):
        start_response('200 OK', [('Content-Type', 'application/json')])
        if send_chunk:
            yield b'{'
        raise failure
    environ = {'PATH_INFO': '/api/a', 'wsgi.input': io.BytesIO(), 'HTTP_X_CRUMBTRAIL_SESSION_ID': 's', 'HTTP_X_CRUMBTRAIL_REQUEST_ID': 'r'}
    response = WSGIMiddleware(app, client)(environ, lambda *args: None)
    with pytest.raises(RuntimeError) as error:
        list(response)
    assert error.value is failure
    assert sink.events[-1]['d']['statusCode'] == expected_status
    assert sink.events[-1]['d']['responseBodyState'] == 'truncated'
    assert sink.events[-2]['k'] == 'backend.req.error'
