import io
import threading
import urllib.error
from unittest.mock import patch

import pytest
from crumbtrail import Sender
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
            raise urllib.error.HTTPError(request.full_url, 404, 'Not found', {}, io.BytesIO())
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
