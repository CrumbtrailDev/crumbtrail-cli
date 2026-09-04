"""Request scoped evidence and bounded asynchronous HTTP delivery."""
import contextvars
import json
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .privacy import capture_body, is_json, redaction, MAX_BYTES

current_capture = contextvars.ContextVar("crumbtrail_capture", default=None)
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


def now():
    return int(time.time() * 1000)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Sender:
    """One worker per process. Construct after worker fork and close on shutdown."""
    def __init__(self, endpoint, key):
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Crumbtrail endpoint must be HTTPS without credentials, query or fragment")
        if not key or any(ord(c) < 32 or ord(c) > 126 for c in key):
            raise ValueError("Crumbtrail ingest key must be nonempty printable ASCII")
        self.url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/api/events", "", ""))
        self.key = key
        self.queue = queue.Queue(maxsize=64)
        self.dropped = 0
        self.failed = 0
        self._closed = False
        self._lock = threading.Lock()
        self._worker = None
        self._pid = os.getpid()
        self._http = urllib.request.build_opener(_NoRedirect())

    def enqueue(self, batch):
        if os.getpid() != self._pid:
            self.dropped += 1
            return
        with self._lock:
            if self._closed:
                self.dropped += 1
                return
            if self._worker is None:
                self._worker = threading.Thread(target=self._run, name="crumbtrail-delivery", daemon=True)
                self._worker.start()
            try:
                self.queue.put_nowait(batch)
            except queue.Full:
                self.dropped += 1

    def _send(self, batch):
        body = json.dumps(batch, allow_nan=False).encode()
        for attempt in range(4):
            request = urllib.request.Request(self.url, data=body, headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"}, method="POST")
            try:
                with self._http.open(request, timeout=5) as response:
                    if response.status == 200:
                        return True
                    if response.status not in (404, 429) and response.status < 500:
                        return False
            except urllib.error.HTTPError as error:
                error.close()
                if error.code not in (404, 429) and error.code < 500:
                    return False
            except (OSError, urllib.error.URLError):
                pass
            if attempt < 3:
                time.sleep(0.25 * (attempt + 1))
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
                    self.failed += 1
            except Exception:
                self.failed += 1
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
        self.response_complete = False
        self.status = 500
        self.response_started = False
        self.response_type = ""
        self.sequence = 0

    def keep(self, target, chunk):
        remaining = MAX_BYTES + 1 - len(target)
        if remaining > 0:
            target.extend(chunk[:remaining])

    def add(self, kind, data):
        if len(self.events) < 198:
            self.events.append({"t": now(), "k": kind, "d": data})
        else:
            self.dropped += 1

    def finish(self, sink, request_type, route="/", error=None):
        try:
            correlation = {"status": "linked", "sessionIdSource": "header", "requestIdSource": "header"}
            common = {"requestId": self.request, "sessionId": self.session, "method": self.method, "url": route, "pathname": route, "route": route, "service": self.service, "correlation": correlation}
            body, state = capture_body(self.request_bytes, not self.request_complete) if is_json(request_type) else (None, "missing")
            start = {"t": self.started, "k": "backend.req.start", "d": dict(common, body=body, requestBodyState=state, redaction=redaction("body", state))}
            if error:
                self.add("backend.req.error", dict(common, error={"name": type(error).__name__}))
            body, state = capture_body(self.response_bytes, not self.response_complete) if is_json(self.response_type) else (None, "missing")
            end = {"t": now(), "k": "backend.req.end", "d": dict(common, statusCode=self.status if error is None or self.response_started else 500, durationMs=(time.monotonic() - self.clock) * 1000, responseBody=body, responseBodyState=state, responseBodyTruncated=state == "truncated", redaction=redaction("responseBody", state))}
            events = [start] + self.events + [end]
            if self.dropped:
                events.append({"t": now(), "k": "capture_gap", "d": {"kind": "capture_gap", "surface": "backend_request", "reason": "scan_budget_exceeded", "requestId": self.request, "detail": "Event limit reached", "droppedEvents": self.dropped}})
            for i in range(0, len(events), 20):
                sink.enqueue({"sessionId": self.session, "events": events[i:i + 20]})
        except Exception:
            pass


class Client:
    def __init__(self, *, service="python", should_capture=None, endpoint=None, key=None, sink=None):
        self.service = service
        self.should_capture = should_capture or (lambda path: False)
        self.sink = sink if sink is not None else Sender(endpoint or os.environ.get("CRUMBTRAIL_ENDPOINT", ""), key or os.environ.get("CRUMBTRAIL_INGEST_KEY", ""))

    def begin(self, path, method, session, request):
        try:
            if _ID.fullmatch(session) and _ID.fullmatch(request) and self.should_capture(path):
                return Capture(session, request, self.service, method)
        except Exception:
            pass
        return None

    def close(self, timeout=5):
        close = getattr(self.sink, "close", None)
        return close(timeout) if close else True
