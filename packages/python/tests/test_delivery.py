import io
import logging
import os
import threading
import urllib.error
from unittest.mock import patch

import pytest
from crumbtrail import Client, Sender
from crumbtrail import core
from crumbtrail.core import Capture


@pytest.mark.parametrize('endpoint', ['http://example.test', 'https://u:p@example.test', 'https://example.test?q=x', 'https://example.test#x', ''])
def test_reject_invalid_endpoint(endpoint):
    with pytest.raises(ValueError):
        Sender(endpoint, 'test-key')


@pytest.mark.parametrize('key', ['', 'bad\nkey', 'bad\rkey', 'bad\x7fkey'])
def test_reject_invalid_key(key):
    with pytest.raises(ValueError):
        Sender('https://example.test', key)


def test_retries_registration_race_and_drains():
    sender = Sender('https://example.test/somepath', 'test-key')
    requests = []
    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
    def open(request, timeout):
        requests.append(request)
        if len(requests) < 3:
            raise urllib.error.HTTPError(request.full_url, 503, 'Unavailable', {}, io.BytesIO())
        return Response()
    sender._http.open = open
    with patch('crumbtrail.core.time.sleep'):
        sender.enqueue({'sessionId': 's', 'events': []})
        assert sender.close(2)
    assert len(requests) == 3
    assert requests[0].full_url == 'https://example.test/api/events'
    assert requests[0].get_header('Authorization') == 'Bearer test-key'
    assert sender.failed == 0
    sender.enqueue({})
    assert sender.dropped == 1


def test_redirect_is_not_followed_or_retried():
    sender = Sender('https://example.test', 'test-key')
    calls = []
    def open(request, timeout):
        calls.append(request)
        raise urllib.error.HTTPError(request.full_url, 302, 'redirect', {'Location': 'https://attacker.test'}, io.BytesIO())
    sender._http.open = open
    assert not sender._send({'sessionId': 's', 'events': []})
    assert len(calls) == 1
    handler = next(h for h in sender._http.handlers if type(h).__name__ == '_NoRedirect')
    assert handler.redirect_request(None, None, 302, '', {}, 'https://attacker.test') is None


def test_queue_bounded_and_close_timeout():
    sender = Sender('https://example.test', 'test-key')
    started, release = threading.Event(), threading.Event()
    def send(batch):
        started.set()
        release.wait(2)
        return True
    sender._send = send
    sender.enqueue({})
    assert started.wait(1)
    for _ in range(65):
        sender.enqueue({})
    assert sender.dropped == 1
    assert not sender.close(0)
    release.set()
    assert sender.close(2)


def test_request_event_budget_has_explicit_gap():
    capture = Capture('s', 'r', 'test', 'GET')
    for i in range(250):
        capture.add('db.statement', {'requestId': 'r'})
    batches = []
    class Sink:
        def enqueue(self, batch):
            batches.append(batch)
    capture.finish(Sink(), '')
    assert all(len(b['events']) <= 20 for b in batches)
    events = [e for b in batches for e in b['events']]
    assert events[0]['k'] == 'backend.req.start'
    assert events[-2]['k'] == 'backend.req.end'
    assert events[-1]['d']['droppedEvents'] == 52


def test_inherited_sender_does_not_use_forked_locks_or_claim_delivery():
    sender = Sender('https://example.test', 'test-key')
    with patch('crumbtrail.core.os.getpid', return_value=sender._pid + 1):
        sender._lock.acquire()
        try:
            sender.enqueue({})
            assert sender.dropped == 1
            assert not sender.close(0)
        finally:
            sender._lock.release()


def test_permanent_rejection_is_not_retried(caplog):
    sender = Sender('https://example.test', 'test-key')
    calls = []
    def open(request, timeout):
        calls.append(request)
        raise urllib.error.HTTPError(request.full_url, 404, 'Not found', {}, io.BytesIO())
    sender._http.open = open
    with caplog.at_level(logging.WARNING, logger='crumbtrail'):
        assert not sender._send({'sessionId': 's', 'events': []})
    assert len(calls) == 1
    assert 'status 404' in caplog.text


def test_retry_after_is_honoured_and_capped():
    sender = Sender('https://example.test', 'test-key')
    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
    codes = [('7', 429), ('99999', 429), (None, 200)]
    def open(request, timeout):
        after, code = codes.pop(0)
        if code == 200:
            return Response()
        raise urllib.error.HTTPError(request.full_url, code, 'slow down', {'Retry-After': after}, io.BytesIO())
    sender._http.open = open
    delays = []
    with patch('crumbtrail.core.time.sleep', delays.append):
        assert sender._send({'sessionId': 's', 'events': []})
    assert delays == [7.0, 30.0]


def test_permanently_dropped_batch_is_logged(caplog):
    sender = Sender('https://example.test', 'test-key')
    def open(request, timeout):
        raise urllib.error.URLError('unreachable')
    sender._http.open = open
    with patch('crumbtrail.core.time.sleep'), caplog.at_level(logging.WARNING, logger='crumbtrail'):
        assert not sender._send({'sessionId': 's', 'events': [1, 2]})
    assert 'dropping 2 events' in caplog.text


@pytest.mark.parametrize('endpoint', ['http://localhost:19890', 'http://127.0.0.1:19890', 'http://[::1]:19890', 'http://cloud.localhost:19890'])
def test_loopback_endpoints_may_use_http(endpoint):
    assert Sender(endpoint, 'test-key').url.endswith('/api/events')


def test_missing_configuration_disables_capture_instead_of_raising(monkeypatch, caplog):
    monkeypatch.delenv('CRUMBTRAIL_ENDPOINT', raising=False)
    monkeypatch.delenv('CRUMBTRAIL_INGEST_KEY', raising=False)
    with caplog.at_level(logging.WARNING, logger='crumbtrail'):
        client = Client(service='orders-api', should_capture=lambda _: True)
    assert 'capture is disabled' in caplog.text
    assert not client.enabled
    assert client.begin('/api/a', 'GET', 'session', 'request') is None
    client.sink.enqueue({'sessionId': 's', 'events': []})
    assert client.sink.dropped == 1
    assert client.close(0)


def test_cross_process_drop_warns_once(caplog):
    sender = Sender('https://example.test', 'test-key')
    with patch('crumbtrail.core.os.getpid', return_value=sender._pid + 1), caplog.at_level(logging.WARNING, logger='crumbtrail'):
        sender.enqueue({})
        sender.enqueue({})
    assert sender.dropped == 2
    assert caplog.text.count('build the client after the worker forks') == 1


def test_flush_at_exit_drains_queued_evidence():
    sender = Sender('https://example.test', 'test-key')
    delivered = []
    sender._send = lambda batch: delivered.append(batch) or True
    sender.enqueue({'sessionId': 's', 'events': []})
    core._flush_at_exit()
    assert delivered == [{'sessionId': 's', 'events': []}]


@pytest.mark.skipif(not hasattr(os, 'fork'), reason='fork is POSIX only')
def test_sender_built_before_fork_delivers_from_the_child():
    """A client at module scope survives gunicorn --preload and uwsgi master forks."""
    sender = Sender('https://example.test', 'test-key')
    parent_pid = sender._pid
    read, write = os.pipe()
    child = os.fork()
    if child == 0:
        code = 1
        try:
            os.close(read)
            delivered = []
            sender._send = lambda batch: delivered.append(batch) or True
            sender.enqueue({'sessionId': 's', 'events': []})
            drained = sender.close(5)
            healthy = drained and len(delivered) == 1 and sender.dropped == 0 and sender._pid != parent_pid
            os.write(write, b'1' if healthy else b'0')
            code = 0
        finally:
            os._exit(code)
    os.close(write)
    result = os.read(read, 1)
    os.close(read)
    assert os.waitpid(child, 0)[1] == 0
    assert result == b'1'
    assert sender.dropped == 0
