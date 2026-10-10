from flask import Blueprint, Flask

app = Flask(__name__)
api = Blueprint("api", __name__, url_prefix="/api")


@app.get("/health")
def health():
    return "ok"


@app.route("/items/<int:item_id>", methods=["GET", "DELETE"])
def item(item_id):
    return str(item_id)


@api.post("/items")
def create_item():
    return "created"


app.register_blueprint(api)
