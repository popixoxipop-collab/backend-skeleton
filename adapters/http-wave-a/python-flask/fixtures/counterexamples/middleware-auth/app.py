from flask import Flask, abort, request

app = Flask(__name__)


@app.before_request
def require_token():
    if request.endpoint != "public" and request.headers.get("Authorization") is None:
        abort(401)


@app.get("/public")
def public():
    return "open"


@app.get("/private")
def private():
    return "secret"
