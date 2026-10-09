from flask import Blueprint, Flask

app = Flask(__name__)
api = Blueprint("api", __name__, url_prefix="/api")


@api.get("/ping")
def ping():
    return "pong"


app.register_blueprint(api, url_prefix="/v2")
