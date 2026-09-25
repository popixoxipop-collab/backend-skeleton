from flask import Flask, Blueprint

app = Flask(__name__)
bp = Blueprint('users', __name__, url_prefix='/users')
app.register_blueprint(bp)

@app.get('/health')
def health():
    return {}

@bp.get('/<int:user_id>')
def user(user_id):
    return {}
