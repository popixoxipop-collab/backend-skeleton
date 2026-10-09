from flask import Blueprint, Flask

app = Flask(__name__, static_url_path="/assets")
admin = Blueprint("admin", __name__, url_prefix="/admin", static_folder="admin_static")


@admin.get("/")
def admin_index():
    return "admin"


app.register_blueprint(admin)
