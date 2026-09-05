"""Django synchronous WSGI integration with request scoped database wrappers."""
from contextlib import ExitStack
from .database import django_execute
from .middleware import WSGIMiddleware


def wrap_wsgi(application, client):
    """Wrap get_wsgi_application() in wsgi.py; queries captured through response iteration."""
    from django.db import connections

    def app(environ, start_response):
        def response():
            with ExitStack() as stack:
                for connection in connections.all():
                    stack.enter_context(connection.execute_wrapper(django_execute))
                iterable = application(environ, start_response)
                try:
                    yield from iterable
                finally:
                    close = getattr(iterable, "close", None)
                    if close:
                        close()
        return response()

    def route(environ):
        from django.urls import resolve, Resolver404
        try:
            return "/" + resolve(environ.get("PATH_INFO", "/")).route
        except Resolver404:
            return "/"
    return WSGIMiddleware(app, client, route)
