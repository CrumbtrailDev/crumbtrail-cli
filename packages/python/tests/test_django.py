import io
import json

from django.conf import settings
if not settings.configured:
    settings.configure(ROOT_URLCONF=__name__, SECRET_KEY='test-only', ALLOWED_HOSTS=['testserver'], DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}})
import django
django.setup()
from django.http import JsonResponse
from django.urls import path
from django.db import connection


def order(request, order_id):
    body = json.loads(request.body)
    with connection.cursor() as cursor:
        cursor.execute('SELECT %s', ['secret database value'])
        assert cursor.fetchone()[0] == 'secret database value'
    return JsonResponse({'amount': body['amount'] * 2, 'orderId': order_id})


urlpatterns = [path('api/orders/<int:order_id>', order)]


def test_django_wsgi_real_request():
    from django.core.wsgi import get_wsgi_application
    from crumbtrail.django import wrap_wsgi
    from crumbtrail import Client
    batches = []
    class Sink:
        def enqueue(self, batch):
            batches.append(batch)
    client = Client(sink=Sink(), should_capture=lambda _: True)
    app = wrap_wsgi(get_wsgi_application(), client)
    raw = b'{"amount":18.75}'
    environ = {'REQUEST_METHOD': 'POST', 'PATH_INFO': '/api/orders/731', 'CONTENT_TYPE': 'application/json', 'CONTENT_LENGTH': str(len(raw)), 'SERVER_NAME': 'testserver', 'SERVER_PORT': '80', 'SERVER_PROTOCOL': 'HTTP/1.1', 'wsgi.url_scheme': 'http', 'wsgi.input': io.BytesIO(raw), 'wsgi.errors': io.StringIO(), 'wsgi.version': (1, 0), 'wsgi.multithread': False, 'wsgi.multiprocess': False, 'wsgi.run_once': False, 'HTTP_X_CRUMBTRAIL_SESSION_ID': 's', 'HTTP_X_CRUMBTRAIL_REQUEST_ID': 'r'}
    statuses = []
    response = app(environ, lambda status, headers, exc_info=None: statuses.append(status))
    assert json.loads(b''.join(response)) == {'amount': 37.5, 'orderId': 731}
    response.close()
    events = [event for batch in batches for event in batch['events']]
    assert [e['k'] for e in events] == ['backend.req.start', 'db.statement', 'backend.req.end']
    assert events[0]['d']['route'] == '/api/orders/<int:order_id>'
    assert 'secret database value' not in json.dumps(events)
    assert not connection.execute_wrappers
