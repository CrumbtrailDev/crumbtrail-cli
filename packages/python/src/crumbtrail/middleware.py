"""Transparent stream tees: capture never pre-reads or consumes application input."""
from .core import current_capture


class _Input:
    def __init__(self, stream, capture, length):
        self._stream, self._capture, self._length = stream, capture, length
        self._count = 0

    def _keep(self, data, eof=False):
        self._capture.keep_request(data)
        self._count += len(data)
        if eof or (self._length is not None and self._count >= self._length):
            self._capture.request_complete = True
        return data

    def read(self, size=-1):
        value = self._stream.read(size)
        return self._keep(value, size < 0 or (size != 0 and not value))

    def readline(self, size=-1):
        value = self._stream.readline(size)
        return self._keep(value, size != 0 and not value)

    def readlines(self, hint=-1):
        lines = []
        count = 0
        while True:
            line = self.readline()
            if not line:
                break
            lines.append(line)
            count += len(line)
            if hint > 0 and count >= hint:
                break
        return lines

    def readinto(self, buffer):
        value = self.read(len(buffer))
        buffer[:len(value)] = value
        return len(value)

    def __iter__(self):
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def __getattr__(self, name):
        return getattr(self._stream, name)


class WSGIMiddleware:
    def __init__(self, app, client, route=None):
        self.app, self.client = app, client
        self.route = route or (lambda environ: environ.get("crumbtrail.route", "/"))

    def __call__(self, environ, start_response):
        capture = self.client.begin(environ.get("PATH_INFO", "/"), environ.get("REQUEST_METHOD", "GET"), environ.get("HTTP_X_CRUMBTRAIL_SESSION_ID", ""), environ.get("HTTP_X_CRUMBTRAIL_REQUEST_ID", ""))
        if capture is None:
            return self.app(environ, start_response)
        declared = environ.get("CONTENT_LENGTH")
        capture.request_length = capture.content_length([("content-length", declared)] if declared not in (None, "") else [])
        length = capture.request_length
        def safe_route():
            try:
                value = self.route(environ)
                return value if isinstance(value, str) and len(value) <= 2048 else "/"
            except Exception:
                return "/"

        original_input = environ["wsgi.input"]
        environ["wsgi.input"] = _Input(original_input, capture, length)
        capture.request_complete = length == 0

        def wrapped_start(status, headers, exc_info=None):
            write = start_response(status, headers, exc_info)
            capture.status = int(status.split(" ", 1)[0])
            capture.response_headers(headers)

            def wrapped_write(chunk):
                result = write(chunk)
                capture.response_started = True
                capture.keep_response(chunk)
                return result
            return wrapped_write

        token = current_capture.set(capture)
        try:
            iterable = self.app(environ, wrapped_start)
        except BaseException as error:
            capture.finish(self.client.sink, environ.get("CONTENT_TYPE", ""), safe_route(), error)
            environ["wsgi.input"] = original_input
            raise
        finally:
            current_capture.reset(token)

        middleware = self

        class Response:
            def __init__(self):
                self.iterator = None
                self.closed = False
                self.error = None

            def __iter__(self):
                return self

            def __next__(self):
                token = current_capture.set(capture)
                try:
                    if self.iterator is None:
                        self.iterator = iter(iterable)
                    chunk = next(self.iterator)
                    capture.keep_response(chunk)
                    if chunk:
                        capture.response_started = True
                    return chunk
                except StopIteration:
                    capture.response_complete = True
                    self.close()
                    raise
                except BaseException as error:
                    self.error = error
                    self.close()
                    raise
                finally:
                    current_capture.reset(token)

            def close(self):
                if self.closed:
                    return
                self.closed = True
                token = current_capture.set(capture)
                try:
                    close = getattr(iterable, "close", None)
                    if close:
                        close()
                except BaseException as failure:
                    if self.error is None:
                        self.error = failure
                        raise
                    # Preserve the primary application exception when cleanup also fails.
                finally:
                    try:
                        capture.finish(middleware.client.sink, environ.get("CONTENT_TYPE", ""), safe_route(), self.error)
                    finally:
                        environ["wsgi.input"] = original_input
                        current_capture.reset(token)

        return Response()


class ASGIMiddleware:
    def __init__(self, app, client):
        self.app, self.client = app, client

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {}
        for key, value in scope.get("headers", []):
            key = key.lower()
            # Duplicate identity headers must not be treated as authoritative.
            headers[key] = value.decode("latin1") if key not in headers else ""
        capture = self.client.begin(scope.get("path", "/"), scope.get("method", "GET"), headers.get(b"x-crumbtrail-session-id", ""), headers.get(b"x-crumbtrail-request-id", ""))
        if capture is None:
            return await self.app(scope, receive, send)

        capture.request_length = capture.content_length([(k.decode("latin1"), v.decode("latin1")) for k, v in scope.get("headers", [])])
        capture.request_complete = capture.request_length == 0

        async def wrapped_receive():
            message = await receive()
            if message["type"] == "http.request":
                capture.keep_request(message.get("body", b""))
                if not message.get("more_body", False):
                    capture.request_complete = True
            return message

        async def wrapped_send(message):
            await send(message)
            if message["type"] == "http.response.start":
                capture.status = message["status"]
                capture.response_started = True
                capture.response_headers([(k.decode("latin1"), v.decode("latin1")) for k, v in message.get("headers", [])])
            elif message["type"] == "http.response.body":
                capture.keep_response(message.get("body", b""))
                if not message.get("more_body", False):
                    capture.response_complete = True

        token = current_capture.set(capture)
        error = None
        try:
            return await self.app(scope, wrapped_receive, wrapped_send)
        except BaseException as failure:
            error = failure
            raise
        finally:
            try:
                route = getattr(scope.get("route"), "path", "/")
                capture.finish(self.client.sink, headers.get(b"content-type", ""), route, error)
            finally:
                current_capture.reset(token)
