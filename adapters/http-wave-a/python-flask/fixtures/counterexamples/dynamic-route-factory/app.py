from flask import Flask

app = Flask(__name__)
NAMES = ["alpha", "beta"]


def make_view(name):
    def view():
        return name

    view.__name__ = name
    return view


for name in NAMES:
    app.add_url_rule(f"/{name}", view_func=make_view(name))
