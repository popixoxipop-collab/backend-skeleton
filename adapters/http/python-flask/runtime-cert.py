#!/usr/bin/env python3
"""Exact-version, bounded Flask leaf conformance and in-process request replay.

Usage: python -B adapters/http/python-flask/runtime-cert.py [--repo-root PATH]
This is an opt-in certification check, not a production registration or release gate.
"""

import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys


EXPECTED_FLASK = "3.1.3"
SUPPORTED = {
    ("normal", "GET", "/health"): (200, "ok"),
    ("counterexamples/middleware-auth", "GET", "/public"): (200, "open"),
}
PROBES = {
    "normal": [("GET", "/health", None), ("GET", "/items/7", None),
               ("DELETE", "/items/7", None), ("POST", "/api/items", None)],
    "counterexamples/default-methods": [("GET", "/ping", None)],
    "counterexamples/deployment-prefix": [("GET", "/ping", None)],
    "counterexamples/dynamic-route-factory": [("GET", "/alpha", None), ("GET", "/beta", None)],
    "counterexamples/generated-routes": [("GET", "/admin/", None)],
    "counterexamples/imperative-registration": [("GET", "/ping", None)],
    "counterexamples/middleware-auth": [("GET", "/public", None),
                                            ("GET", "/private", None),
                                            ("GET", "/private", "Bearer test")],
    "counterexamples/router-prefix": [("GET", "/v2/ping", None),
                                           ("GET", "/api/ping", None)],
}


def run(*argv, cwd=None):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.check_output(argv, cwd=cwd, env=env, text=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def probe_one(directory, probe_rows):
    os.chdir(directory)
    sys.path.insert(0, str(directory))
    app = importlib.import_module("app").app
    client = app.test_client()
    rows = []
    for method, route, authorization in probe_rows:
        headers = {"Authorization": authorization} if authorization else {}
        response = client.open(route, method=method, headers=headers)
        rows.append({"method": method, "path": route, "authorization": bool(authorization),
                     "status": response.status_code, "body": response.get_data(as_text=True)})
    print(json.dumps(rows, sort_keys=True))


def main(root):
    if importlib.metadata.version("flask") != EXPECTED_FLASK:
        raise AssertionError(f"Flask {EXPECTED_FLASK} is required")
    fixture_root = root / "adapters/http-wave-a/python-flask/fixtures"
    oracle_py = root / "adapters/http-wave-a/python-scope/oracle.py"
    static_js = root / "adapters/http-wave-a/python-scope/static-runner.mjs"
    stored_root = root / "adapters/http-wave-a/python-flask/results"
    oracle_command = [sys.executable, "-B", str(oracle_py), "flask", str(fixture_root)]
    static_command = ["node", str(static_js), "flask", str(fixture_root)]
    oracle_text = run(*oracle_command, cwd=root)
    static_text = run(*static_command, cwd=root)
    if oracle_text != run(*oracle_command, cwd=root) or static_text != run(*static_command, cwd=root):
        raise AssertionError("oracle/static replay is nondeterministic")
    oracle = json.loads(oracle_text)
    static = json.loads(static_text)
    stored_oracle = json.loads((stored_root / "oracle.json").read_text())
    stored_static = json.loads((stored_root / "static.json").read_text())
    if oracle["fixtures"] != stored_oracle["fixtures"]:
        raise AssertionError("live Flask route table differs from pinned independent oracle")
    if static != stored_static:
        raise AssertionError("live T06/T12 static leaf differs from pinned result")
    if set(oracle["fixtures"]) != set(PROBES) or set(static["fixtures"]) != set(PROBES):
        raise AssertionError("fixture corpus changed")
    if oracle["framework"] != {"name": "flask", "version": EXPECTED_FLASK}:
        raise AssertionError("framework version changed")
    scope = json.loads((root / "adapters/http-wave-a/python-flask/SCOPE.json").read_text())
    registration = scope["registration"]["entry"]
    if registration["productionDefault"] or registration["t19Review"] != "NOT_REVIEWED":
        raise AssertionError("unregistered/T19-unreviewed scope boundary changed")
    for fixture, method, route in SUPPORTED:
        leaf = static["fixtures"][fixture]["layers"]["t12-flask-leaf"]
        if {"method": method, "path": route} not in leaf["routes"]:
            raise AssertionError(f"supported leaf route absent: {fixture} {method} {route}")
        if not any(item["path"] == route and method in item["methods"] and not item["generated"]
                   for item in oracle["fixtures"][fixture]["routes"]):
            raise AssertionError(f"supported Flask route absent: {fixture} {method} {route}")
    # Known counterexamples must remain outside this limited certificate, even when Flask serves them.
    negative = {
        "counterexamples/dynamic-route-factory": "/alpha",
        "counterexamples/imperative-registration": "/ping",
        "counterexamples/router-prefix": "/v2/ping",
    }
    for fixture, route in negative.items():
        leaf_routes = static["fixtures"][fixture]["layers"]["t12-flask-leaf"]["routes"]
        if any(item["path"] == route for item in leaf_routes):
            raise AssertionError(f"known unsupported route was silently claimed: {fixture} {route}")
        if not any(item["path"] == route and not item["generated"]
                   for item in oracle["fixtures"][fixture]["routes"]):
            raise AssertionError(f"negative control disappeared from Flask: {fixture} {route}")
    probed = {}
    for fixture, rows in PROBES.items():
        directory = fixture_root / fixture
        output = run(sys.executable, "-B", str(Path(__file__).resolve()), "--probe-one",
                     str(directory), json.dumps(rows), cwd=root)
        results = json.loads(output)
        probed[fixture] = [{key: item[key] for key in ("method", "path", "authorization", "status")}
                           for item in results]
        for result in results:
            key = (fixture, result["method"], result["path"])
            if key in SUPPORTED and (result["status"], result["body"]) != SUPPORTED[key]:
                raise AssertionError(f"supported HTTP response drifted: {key}")
            expected_status = 401 if fixture == "counterexamples/middleware-auth" and \
                result["path"] == "/private" and not result["authorization"] else \
                404 if fixture == "counterexamples/router-prefix" and result["path"] == "/api/ping" else 200
            if result["status"] != expected_status:
                raise AssertionError(f"HTTP probe drifted: {key}: {result['status']} != {expected_status}")
    if probed["counterexamples/middleware-auth"][1]["status"] != 401 or \
            probed["counterexamples/middleware-auth"][2]["status"] != 200 or \
            probed["counterexamples/router-prefix"][1]["status"] != 404:
        raise AssertionError("negative HTTP probe drifted")
    source_paths = [
        "adapters/http-wave-a/flask.mjs",
        "scanners/language/python/flask-shadow.mjs",
        "adapters/http-wave-a/python-scope/oracle.py",
        "adapters/http-wave-a/python-scope/static-runner.mjs",
        "adapters/http-wave-a/python-flask/SCOPE.json",
        "adapters/http/python-flask/runtime-cert.py",
    ]
    report = {
        "schema": "bskel.http-python-flask-limited-certificate/1",
        "status": "LIMITED_CONFORMANCE",
        "framework": oracle["framework"],
        "python": oracle["python"],
        "fixture_count": len(PROBES),
        "http_probe_count": sum(map(len, PROBES.values())),
        "supported": [{"fixture": f, "method": m, "path": p} for f, m, p in sorted(SUPPORTED)],
        "excluded_negative_controls": negative,
        "oracle_sha256": hashlib.sha256(oracle_text.encode()).hexdigest(),
        "static_sha256": hashlib.sha256(static_text.encode()).hexdigest(),
        "source_sha256": {name: digest(Path(__file__).resolve() if name.endswith("runtime-cert.py") else root / name)
                          for name in source_paths},
        "runtime_tested": True,
        "production_registered": False,
        "limitations": ["Only two literal GET paths are certified; all other routes are excluded.",
                        "Flask test_client is in-process; no bound network server or deployment proxy is tested.",
                        "Middleware authorization, generated and dynamic routes are not certified as scanner support.",
                        "T12 leaf remains candidate/unregistered and does not become a release claim."],
    }
    print(json.dumps(report, sort_keys=True, indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--probe-one":
        probe_one(Path(sys.argv[2]), json.loads(sys.argv[3]))
    elif len(sys.argv) == 1:
        main(Path(__file__).resolve().parents[3])
    elif len(sys.argv) == 3 and sys.argv[1] == "--repo-root":
        main(Path(sys.argv[2]).resolve())
    else:
        sys.exit("usage: runtime-cert.py [--repo-root PATH]")
