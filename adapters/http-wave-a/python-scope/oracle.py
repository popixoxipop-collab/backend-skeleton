"""Framework-own route-table oracle for the Python HTTP scope records (HTTP-python-*-01).

    python oracle.py <flask|fastapi|django|starlette|litestar> <fixtures-root>

Every directory under <fixtures-root> that holds app.py (urls.py for django) is imported in a fresh
child interpreter, the installed framework is asked for its own route table, and one canonical JSON
document is printed. This script shares no code with the bskel scanners: it is the independent side
of the conformance comparison. It reports what the framework registered at import time. It never
serves a request, so it is a route-table oracle and not a runtime test.
"""
import importlib
import importlib.metadata as metadata
import json
import os
import platform
import subprocess
import sys

sys.dont_write_bytecode = True
ENTRY = {"django": "urls.py"}
GENERATED_MODULES = {
    "flask": ("flask", "werkzeug"),
    "fastapi": ("fastapi", "starlette"),
    "starlette": ("starlette",),
    "litestar": ("litestar",),
    "django": ("django.contrib.admin", "rest_framework"),
}


def generated_group(framework, obj):
    module = getattr(obj, "__module__", "") or ""
    return next((m for m in GENERATED_MODULES[framework] if module == m or module.startswith(m + ".")), None)


def is_generated(framework, obj):
    return generated_group(framework, obj) is not None


def methods_of(route):
    methods = getattr(route, "methods", None)
    return sorted(methods) if methods else None


def flask_rows(module):
    app = module.app
    return [
        {"path": rule.rule, "methods": sorted(rule.methods or ()), "name": rule.endpoint,
         "generated": is_generated("flask", app.view_functions.get(rule.endpoint))}
        for rule in app.url_map.iter_rules()
    ]


def starlette_rows(framework, routes, prefix=""):
    rows = []
    for route in routes:
        kind = type(route).__name__
        path = prefix + getattr(route, "path", "")
        children = list(getattr(route, "routes", None) or [])
        if kind in ("Mount", "Host") and children:
            rows.extend(starlette_rows(framework, children, path))
            continue
        rows.append({"kind": kind, "path": path or "/", "methods": methods_of(route),
                     "name": getattr(route, "name", None),
                     "generated": is_generated(framework, getattr(route, "endpoint", None))})
    return rows


def fastapi_rows(app):
    # FastAPI >= 0.143 keeps include_router() as a lazy _IncludedRouter in app.routes; its own public
    # iter_route_contexts() is the framework's flattened view (effective prefix, methods, endpoint).
    from fastapi.routing import iter_route_contexts
    rows = []
    for context in iter_route_contexts(app.routes):
        route = context.original_route
        path = context.path or ""
        children = list(getattr(route, "routes", None) or [])
        if type(route).__name__ in ("Mount", "Host") and children:
            rows.extend(starlette_rows("fastapi", children, path))
            continue
        rows.append({"kind": type(route).__name__, "path": path or "/", "methods": methods_of(context),
                     "name": context.name, "generated": is_generated("fastapi", context.endpoint)})
    return rows


def litestar_rows(module):
    rows = []
    for route in module.app.routes:
        kind = type(route).__name__
        handlers = getattr(route, "route_handler_map", None)
        if kind == "HTTPRoute" and handlers:
            for method, item in handlers.items():
                handler = item[0] if isinstance(item, tuple) else item
                rows.append({"kind": kind, "path": route.path, "methods": [str(getattr(method, "value", method))],
                             "name": getattr(handler, "handler_name", None),
                             "generated": is_generated("litestar", getattr(handler, "fn", None))})
        else:
            rows.append({"kind": kind, "path": route.path, "methods": None, "name": None, "generated": False})
    return rows


def django_rows(_module):
    from django.urls import get_resolver
    from django.urls.resolvers import URLResolver
    rows, groups = [], {}

    def walk(patterns, prefix, regex, owner=None):
        for item in patterns:
            text = prefix + str(item.pattern)
            is_regex = regex or type(item.pattern).__name__ == "RegexPattern"
            group = owner or ("django.contrib.admin" if getattr(item, "app_name", None) == "admin" else None)
            if isinstance(item, URLResolver):
                walk(item.url_patterns, text, is_regex, group)
                continue
            callback = item.callback
            group = group or generated_group("django", callback)
            if group:
                groups.setdefault(group, []).append("/" + text)
                continue
            actions = getattr(callback, "actions", None)
            rows.append({"path": "/" + text, "regex": is_regex, "name": item.name, "methods": None,
                         "viewset_actions": sorted(actions) if actions else None,
                         "view": item.lookup_str, "generated": False})

    walk(get_resolver().url_patterns, "", False)
    summary = [{"group": name, "count": len(paths), "paths_sorted": sorted(paths)} for name, paths in sorted(groups.items())]
    return rows, summary


def child(framework, directory):
    os.chdir(directory)
    sys.path.insert(0, directory)
    summary = []
    if framework == "django":
        import django
        os.environ["DJANGO_SETTINGS_MODULE"] = "settings"
        django.setup()
        rows, summary = django_rows(None)
    else:
        module = importlib.import_module("app")
        if framework == "flask":
            rows = flask_rows(module)
        elif framework == "fastapi":
            rows = fastapi_rows(module.app)
        elif framework == "litestar":
            rows = litestar_rows(module)
        else:
            rows = starlette_rows(framework, module.app.routes)
    rows.sort(key=lambda r: (r["path"], json.dumps(r["methods"]), r.get("name") or ""))
    print(json.dumps({"routes": rows, "generated_groups": summary}, sort_keys=True))


def parent(framework, root):
    entry = ENTRY.get(framework, "app.py")
    found = sorted(os.path.relpath(base, root) for base, _dirs, files in os.walk(root) if entry in files)
    fixtures = {}
    for rel in found:
        proc = subprocess.run([sys.executable, "-B", os.path.abspath(__file__), "--one", framework,
                               os.path.abspath(os.path.join(root, rel))],
                              capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        if proc.returncode == 0:
            fixtures[rel] = {"error": None, **json.loads(proc.stdout)}
        else:
            last = (proc.stderr.strip().splitlines() or ["unknown error"])[-1]
            fixtures[rel] = {"error": last, "routes": [], "generated_groups": []}
    report = {
        "oracle": "framework-route-table",
        "framework": {"name": framework, "version": metadata.version(framework)},
        "python": {"version": platform.python_version(), "implementation": sys.implementation.name,
                   "system": platform.system(), "machine": platform.machine()},
        "fixtures": fixtures,
    }
    sys.stdout.write(json.dumps(report, sort_keys=True, indent=1) + "\n")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "--one":
        child(args[1], args[2])
    elif len(args) == 2 and args[0] in GENERATED_MODULES:
        parent(args[0], args[1])
    else:
        sys.exit("usage: oracle.py <flask|fastapi|django|starlette|litestar> <fixtures-root>")
