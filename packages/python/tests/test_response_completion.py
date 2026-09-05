import asyncio
import io

import pytest

from crumbtrail import ASGIMiddleware, Client, WSGIMiddleware


@pytest.mark.parametrize('adapter', ['wsgi', 'asgi'])
@pytest.mark.parametrize('method,status,length,chunks,state', [
    ('GET', 200, '4', [b'1'], 'truncated'),
    ('GET', 200, '1', [b'1'], 'captured'),
    ('GET', 200, None, [b'1'], 'captured'),
    ('GET', 200, '2', [b'1', b'2'], 'captured'),
    ('GET', 200, '0', [b'1'], 'truncated'),
    ('GET', 200, 'invalid', [b'1'], 'truncated'),
    ('GET', 200, '32768', [b' ' * 16384, b'1'], 'truncated'),
    ('GET', 200, '0', [], 'missing'),
    ('HEAD', 200, '4', [], 'missing'),
    ('GET', 204, '4', [], 'missing'),
    ('GET', 205, None, [], 'missing'),
    ('GET', 304, '4', [], 'missing'),
])
def test_response_completion(adapter, method, status, length, chunks, state):
    batches = []
    class Sink:
        def enqueue(self, batch):
            batches.append(batch)
    client = Client(sink=Sink(), should_capture=lambda _: True)
    response_headers = [('Content-Type', 'application/json')]
    if length is not None:
        response_headers.append(('Content-Length', length))
    if adapter == 'wsgi':
        def app(environ, start_response):
            start_response(str(status) + ' Test', response_headers)
            yield from chunks
        environ = {'PATH_INFO': '/api/a', 'REQUEST_METHOD': method, 'wsgi.input': io.BytesIO(), 'HTTP_X_CRUMBTRAIL_SESSION_ID': 's', 'HTTP_X_CRUMBTRAIL_REQUEST_ID': 'r'}
        statuses = []
        response = WSGIMiddleware(app, client)(environ, lambda status, *args: statuses.append(status))
        assert list(response) == chunks
        assert statuses == [str(status) + ' Test']
    else:
        emitted = []
        async def app(scope, receive, send):
            await send({'type': 'http.response.start', 'status': status, 'headers': [(k.encode(), v.encode()) for k, v in response_headers]})
            for chunk in chunks:
                await send({'type': 'http.response.body', 'body': chunk, 'more_body': True})
            await send({'type': 'http.response.body', 'body': b'', 'more_body': False})
        async def run():
            async def receive():
                return {'type': 'http.request', 'body': b''}
            async def send(message):
                emitted.append(message)
            await ASGIMiddleware(app, client)({'type': 'http', 'method': method, 'path': '/api/a', 'headers': [(b'x-crumbtrail-session-id', b's'), (b'x-crumbtrail-request-id', b'r')]}, receive, send)
        asyncio.run(run())
        assert emitted[0]['status'] == status
        assert [m['body'] for m in emitted[1:]] == chunks + [b'']
    event = batches[-1]['events'][-1]['d']
    assert event['responseBodyState'] == state
    assert event['statusCode'] == status
    if state in ('missing', 'truncated'):
        assert event['responseBody'] is None


@pytest.mark.parametrize('adapter', ['wsgi', 'asgi'])
@pytest.mark.parametrize('length,raw,state', [
    ('4', b'1', 'truncated'),
    ('1', b'1', 'captured'),
    (None, b'1', 'captured'),
    ('0', b'', 'missing'),
    ('1', b'12', 'truncated'),
    ('invalid', b'1', 'truncated'),
    ('-1', b'1', 'truncated'),
])
def test_request_completion(adapter, length, raw, state):
    batches = []
    class Sink:
        def enqueue(self, batch):
            batches.append(batch)
    client = Client(sink=Sink(), should_capture=lambda _: True)
    if adapter == 'wsgi':
        def app(environ, start_response):
            assert environ['wsgi.input'].read() == raw
            start_response('200 OK', [('Content-Type', 'application/json')])
            return [b'1']
        environ = {'PATH_INFO': '/api/a', 'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': 'application/json', 'wsgi.input': io.BytesIO(raw), 'HTTP_X_CRUMBTRAIL_SESSION_ID': 's', 'HTTP_X_CRUMBTRAIL_REQUEST_ID': 'r'}
        if length is not None:
            environ['CONTENT_LENGTH'] = length
        assert list(WSGIMiddleware(app, client)(environ, lambda *args: None)) == [b'1']
    else:
        message = {'type': 'http.request', 'body': raw, 'more_body': False}
        async def app(scope, receive, send):
            assert await receive() is message
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            await send({'type': 'http.response.body', 'body': b'1'})
        async def run():
            async def receive():
                return message
            async def send(message):
                pass
            headers = [(b'x-crumbtrail-session-id', b's'), (b'x-crumbtrail-request-id', b'r'), (b'content-type', b'application/json')]
            if length is not None:
                headers.append((b'content-length', length.encode()))
            await ASGIMiddleware(app, client)({'type': 'http', 'method': 'POST', 'path': '/api/a', 'headers': headers}, receive, send)
        asyncio.run(run())
    assert batches[0]['events'][0]['d']['requestBodyState'] == state
    assert batches[-1]['events'][-1]['d']['statusCode'] == 200
