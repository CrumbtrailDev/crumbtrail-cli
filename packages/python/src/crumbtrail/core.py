"""Request scoped evidence and bounded asynchronous HTTP delivery."""
import atexit
import contextvars
import datetime
import email.utils
import ipaddress
import json
import logging
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import weakref

from .privacy import capture_body, is_json, redaction, MAX_BYTES

log = logging.getLogger("crumbtrail")

current_capture = contextvars.ContextVar("crumbtrail_capture", default=None)
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_SECONDS = re.compile(r"[0-9]{1,5}")
_MAX_RETRY_AFTER = 30.0


def now():
    return int(time.time() * 1000)


def _loopback(hostname):
    """Local stacks are served over plain HTTP, so exempt loopback from the HTTPS rule."""
    if not hostname:
        return False
    host = hostname.lower().strip("[]")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Senders are tracked weakly so the fork and exit hooks below can reach every live
# sender without keeping a dead one alive. The lock is taken before every fork and
# released on both sides, otherwise a child could inherit it already held.
_registry_lock = threading.Lock()
_registry = []


def _register(sender):
    with _registry_lock:
        _registry[:] = [ref for ref in _registry if ref() is not None]
        _registry.append(weakref.ref(sender))


def _live_senders():
    with _registry_lock:
        refs = list(_registry)
    return [sender for sender in (ref() for ref in refs) if sender is not None]


def _before_fork():
    _registry_lock.acquire()


def _after_fork_parent():
    _registry_lock.release()


def _after_fork_child():
    try:
        senders = [ref() for ref in _registry]
    finally:
        _registry_lock.release()
    for sender in senders:
        if sender is not None:
            sender._adopt_fork()


def _flush_at_exit():
    for sender in _live_senders():
        try:
            sender.close(2)
        except Exception:
            log.debug("Crumbtrail: flush at interpreter exit failed", exc_info=True)


if hasattr(os, "register_at_fork"):
    os.register_at_fork(before=_before_fork, after_in_parent=_after_fork_parent, after_in_child=_after_fork_child)
atexit.register(_flush_at_exit)


class Sender:
    """One worker per process. Rebuilt automatically in a forked child; close on shutdown."""
    def __init__(self, endpoint, key):
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Crumbtrail endpoint must be HTTPS without credentials, query or fragment")
        if parsed.scheme == "http" and not _loopback(parsed.hostname):
            raise ValueError("Crumbtrail endpoint must be HTTPS unless it is a loopback address")
        if not key or any(ord(c) < 32 or ord(c) > 126 for c in key):
            raise ValueError("Crumbtrail ingest key must be nonempty printable ASCII")
        self.url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/api/events", "", ""))
        self.key = key
        self.dropped = 0
        self.failed = 0
        self._counters = threading.Lock()
        self._closed = False
        self._warned_fork = False
        self.queue = queue.Queue(maxsize=64)
        self._lock = threading.Lock()
        self._worker = None
        self._pid = os.getpid()
        self._http = urllib.request.build_opener(_NoRedirect())
        _register(self)

    def _adopt_fork(self):
        """Runs single threaded in the child, so state is replaced by assignment.

        Only this thread survives fork, so the queue, the worker and both locks are
        rebuilt. `_closed` is inherited on purpose: a sender the parent shut down
        stays shut down.
        """
        self.queue = queue.Queue(maxsize=64)
        self._lock = threading.Lock()
        self._counters = threading.Lock()
        self._worker = None
        self._pid = os.getpid()

    def _count_drop(self):
        with self._counters:
            self.dropped += 1

    def _count_failure(self):
        with self._counters:
            self.failed += 1

    def enqueue(self, batch):
        if os.getpid() != self._pid:
            self._count_drop()
            if not self._warned_fork:
                self._warned_fork = True
                log.warning("Crumbtrail: dropping evidence in process %d from a sender built in process %d; build the client after the worker forks", os.getpid(), self._pid)
            return
        with self._lock:
            if self._closed:
                self._count_drop()
                return
            if self._worker is None:
                self._worker = threading.Thread(target=self._run, name="crumbtrail-delivery", daemon=True)
                self._worker.start()
            try:
                self.queue.put_nowait(batch)
            except queue.Full:
                self._count_drop()
                log.debug("Crumbtrail: delivery queue is full, dropping a batch")

    @staticmethod
    def _retryable(status):
        # A 404 means the session is not one this key owns, which no retry changes.
        return status == 429 or status >= 500

    @staticmethod
    def _retry_after(headers, status):
        if status != 429 or headers is None:
            return None
        try:
            value = headers.get("Retry-After")
        except Exception:
            return None
        if value is None:
            return None
        value = str(value).strip()
        if _SECONDS.fullmatch(value):
            return min(float(value), _MAX_RETRY_AFTER)
        try:
            stamp = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if stamp is None:
            return None
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=datetime.timezone.utc)
        seconds = (stamp - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        return max(0.0, min(seconds, _MAX_RETRY_AFTER))

    def _send(self, batch):
        body = json.dumps(batch, allow_nan=False).encode()
        for attempt in range(4):
            request = urllib.request.Request(self.url, data=body, headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"}, method="POST")
            delay = None
            try:
                with self._http.open(request, timeout=5) as response:
                    if response.status == 200:
                        return True
                    if not self._retryable(response.status):
                        log.warning("Crumbtrail: ingest rejected a batch with status %s", response.status)
                        return False
                    delay = self._retry_after(getattr(response, "headers", None), response.status)
            except urllib.error.HTTPError as error:
                code, headers = error.code, error.headers
                error.close()
                if not self._retryable(code):
                    log.warning("Crumbtrail: ingest rejected a batch with status %s", code)
                    return False
                delay = self._retry_after(headers, code)
            except (OSError, urllib.error.URLError) as failure:
                log.debug("Crumbtrail: delivery attempt %d failed: %r", attempt + 1, failure)
            if attempt < 3:
                time.sleep(0.25 * (attempt + 1) if delay is None else delay)
        log.warning("Crumbtrail: dropping %d events after 4 delivery attempts", len(batch.get("events") or []) if isinstance(batch, dict) else 0)
        return False

    def _run(self):
        while True:
            try:
                batch = self.queue.get(timeout=0.1)
            except queue.Empty:
                if self._closed:
                    return
                continue
            try:
                if not self._send(batch):
                    self._count_failure()
            except Exception:
                self._count_failure()
                log.debug("Crumbtrail: delivery worker raised", exc_info=True)
            finally:
                self.queue.task_done()

    def close(self, timeout=5):
        """Stop accepting evidence and wait at most timeout seconds for queued delivery."""
        if os.getpid() != self._pid:
            return False
        with self._lock:
            self._closed = True
        if self._worker:
            self._worker.join(max(0, timeout))
        return self.queue.unfinished_tasks == 0


class _Disabled:
    """Sink used when configuration is unusable. Capture stays off and nothing is sent."""
    def __init__(self):
        self.dropped = 0
        self.failed = 0

    def enqueue(self, batch):
        self.dropped += 1

    def close(self, timeout=5):
        return True


def _build_sender(endpoint, key):
    try:
        return Sender(endpoint, key)
    except ValueError as reason:
        log.warning("Crumbtrail: capture is disabled, %s", reason)
        return _Disabled()


class Capture:
    def __init__(self, session, request, service, method):
        self.session, self.request, self.service, self.method = session, request, service, method
        self.started = now()
        self.clock = time.monotonic()
        self.events = []
        self.dropped = 0
        self.request_bytes = bytearray()
        self.response_bytes = bytearray()
        self.request_complete = False
        self.request_count = 0
        self.request_length = None
        self.response_complete = False
        self.status = 500
        self.response_started = False
        self.response_type = ""
        self.response_count = 0
        self.response_length = None
        self.sequence = 0

    def keep(self, target, chunk):
        remaining = MAX_BYTES + 1 - len(target)
        if remaining > 0:
            target.extend(chunk[:remaining])

    @staticmethod
    def content_length(headers):
        lengths = [v for k, v in headers if k.lower() == "content-length"]
        if not lengths:
            return None
        value = lengths[0].strip()
        return int(value) if len(lengths) == 1 and re.fullmatch(r"[0-9]{1,20}", value) else -1

    def keep_request(self, chunk):
        self.request_count += len(chunk)
        self.keep(self.request_bytes, chunk)

    def request_body(self, content_type):
        if not is_json(content_type):
            return None, "missing"
        complete = self.request_complete and (self.request_length is None or self.request_count == self.request_length)
        return capture_body(self.request_bytes, not complete)

    def response_headers(self, headers):
        self.response_type = next((v for k, v in headers if k.lower() == "content-type"), "")
        self.response_length = self.content_length(headers)

    def keep_response(self, chunk):
        self.response_count += len(chunk)
        self.keep(self.response_bytes, chunk)

    def response_body(self):
        no_body = self.method.upper() == "HEAD" or 100 <= self.status < 200 or self.status in (204, 205, 304) or (self.method.upper() == "CONNECT" and 200 <= self.status < 300)
        if no_body or not is_json(self.response_type):
            return None, "missing"
        complete = self.response_complete and (self.response_length is None or self.response_count == self.response_length)
        return capture_body(self.response_bytes, not complete)

    def add(self, kind, data):
        if len(self.events) < 198:
            self.events.append({"t": now(), "k": kind, "d": data})
        else:
            self.dropped += 1

    def finish(self, sink, request_type, route="/", error=None):
        try:
            correlation = {"status": "linked", "sessionIdSource": "header", "requestIdSource": "header"}
            common = {"requestId": self.request, "sessionId": self.session, "method": self.method, "url": route, "pathname": route, "route": route, "service": self.service, "correlation": correlation}
            body, state = self.request_body(request_type)
            start = {"t": self.started, "k": "backend.req.start", "d": dict(common, body=body, requestBodyState=state, redaction=redaction("body", state))}
            if error:
                self.add("backend.req.error", dict(common, error={"name": type(error).__name__}))
            body, state = self.response_body()
            end = {"t": now(), "k": "backend.req.end", "d": dict(common, statusCode=self.status if error is None or self.response_started else 500, durationMs=(time.monotonic() - self.clock) * 1000, responseBody=body, responseBodyState=state, responseBodyTruncated=state == "truncated", redaction=redaction("responseBody", state))}
            events = [start] + self.events + [end]
            if self.dropped:
                events.append({"t": now(), "k": "capture_gap", "d": {"kind": "capture_gap", "surface": "backend_request", "reason": "scan_budget_exceeded", "requestId": self.request, "detail": "Event limit reached", "droppedEvents": self.dropped}})
            for i in range(0, len(events), 20):
                sink.enqueue({"sessionId": self.session, "events": events[i:i + 20]})
        except Exception:
            log.debug("Crumbtrail: could not assemble request evidence", exc_info=True)


class Client:
    def __init__(self, *, service="python", should_capture=None, endpoint=None, key=None, sink=None):
        self.service = service
        self.should_capture = should_capture or (lambda path: False)
        self.sink = sink if sink is not None else _build_sender(endpoint or os.environ.get("CRUMBTRAIL_ENDPOINT", ""), key or os.environ.get("CRUMBTRAIL_INGEST_KEY", ""))
        self.enabled = not isinstance(self.sink, _Disabled)

    def begin(self, path, method, session, request):
        if not self.enabled:
            return None
        try:
            if _ID.fullmatch(session) and _ID.fullmatch(request) and self.should_capture(path):
                return Capture(session, request, self.service, method)
        except Exception:
            log.debug("Crumbtrail: capture eligibility check raised", exc_info=True)
        return None

    def close(self, timeout=5):
        close = getattr(self.sink, "close", None)
        return close(timeout) if close else True
