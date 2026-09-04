from .middleware import WSGIMiddleware


def install(app, client):
    """Register once, before Flask handles its first request."""
    if "crumbtrail" in app.extensions:
        return app.extensions["crumbtrail"]
    from flask import request

    @app.before_request
    def route_template():
        request.environ["crumbtrail.route"] = request.url_rule.rule if request.url_rule else "/"

    app.wsgi_app = WSGIMiddleware(app.wsgi_app, client)
    app.extensions["crumbtrail"] = client
    return client
