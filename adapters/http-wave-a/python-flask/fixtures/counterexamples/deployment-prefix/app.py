from flask import Flask
from werkzeug.middleware.dispatcher import DispatcherMiddleware

app = Flask(__name__)
app.config["APPLICATION_ROOT"] = "/svc"


@app.get("/ping")
def ping():
    return "pong"


application = DispatcherMiddleware(Flask("root"), {"/svc": app.wsgi_app})
