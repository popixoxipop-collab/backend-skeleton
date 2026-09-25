#!/usr/bin/env python3
"""Static Python source parser for bskel T06.

Reads one JSON request from stdin and writes one JSON response to stdout.
It never imports or executes the target source.
"""
import ast
import json
import sys

REQ = "bskel.python-ast.request/1"
RESP = "bskel.python-ast.response/1"


def span(node):
    out = {"line": getattr(node, "lineno", None), "column": getattr(node, "col_offset", None)}
    end_line = getattr(node, "end_lineno", None)
    end_col = getattr(node, "end_col_offset", None)
    if end_line is not None:
        out["end_line"] = end_line
    if end_col is not None:
        out["end_column"] = end_col
    return out


def symbol_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = symbol_name(node.value)
        return (base + "." + node.attr) if base else None
    return None


def value(node, depth=0):
    if node is None:
        return {"kind": "missing"}
    if depth > 12:
        return {"kind": "unknown", "node": type(node).__name__, "reason": "depth-limit"}
    if isinstance(node, ast.Constant):
        v = node.value
        if isinstance(v, (str, int, float, bool)) or v is None:
            return {"kind": "constant", "value": v}
        return {"kind": "unknown", "node": type(node).__name__}
    sym = symbol_name(node)
    if sym:
        return {"kind": "symbol", "name": sym}
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return {"kind": "sequence", "container": type(node).__name__.lower(), "items": [value(x, depth + 1) for x in node.elts]}
    if isinstance(node, ast.Dict):
        return {"kind": "mapping", "entries": [
            {"key": value(k, depth + 1), "value": value(v, depth + 1)} for k, v in zip(node.keys, node.values)
        ]}
    if isinstance(node, ast.Call):
        return {
            "kind": "call",
            "callee": value(node.func, depth + 1),
            "args": [value(x, depth + 1) for x in node.args],
            "keywords": [{"name": kw.arg, "value": value(kw.value, depth + 1)} for kw in node.keywords],
        }
    if isinstance(node, ast.Subscript):
        return {"kind": "subscript", "base": value(node.value, depth + 1), "slice": value(node.slice, depth + 1)}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)) and isinstance(node.operand, ast.Constant) and isinstance(node.operand.value, (int, float)):
        sign = -1 if isinstance(node.op, ast.USub) else 1
        return {"kind": "constant", "value": sign * node.operand.value}
    return {"kind": "unknown", "node": type(node).__name__}


def target_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, (ast.Tuple, ast.List)):
        names = [target_name(x) for x in node.elts]
        return names if all(x is not None for x in names) else None
    return None


def assignment(node):
    if isinstance(node, ast.AnnAssign):
        return {
            "targets": [target_name(node.target)],
            "annotation": value(node.annotation),
            "value": value(node.value),
            **span(node),
        }
    if isinstance(node, ast.Assign):
        return {
            "targets": [target_name(x) for x in node.targets],
            "annotation": {"kind": "missing"},
            "value": value(node.value),
            **span(node),
        }
    return None


def argument(arg, default=None, kind="positional"):
    return {
        "name": arg.arg,
        "kind": kind,
        "annotation": value(arg.annotation),
        "default": value(default),
        **span(arg),
    }


def function(node):
    defaults = [None] * (len(node.args.args) - len(node.args.defaults)) + list(node.args.defaults)
    args = [argument(a, d) for a, d in zip(node.args.args, defaults)]
    if node.args.vararg:
        args.append(argument(node.args.vararg, None, "vararg"))
    for a, d in zip(node.args.kwonlyargs, node.args.kw_defaults):
        args.append(argument(a, d, "keyword-only"))
    if node.args.kwarg:
        args.append(argument(node.args.kwarg, None, "kwarg"))
    return {
        "name": node.name,
        "async": isinstance(node, ast.AsyncFunctionDef),
        "decorators": [value(x) for x in node.decorator_list],
        "arguments": args,
        "returns": value(node.returns),
        **span(node),
    }


def import_fact(node):
    if isinstance(node, ast.Import):
        return {
            "kind": "import",
            "module": None,
            "level": 0,
            "names": [{"name": x.name, "alias": x.asname} for x in node.names],
            **span(node),
        }
    return {
        "kind": "from",
        "module": node.module,
        "level": node.level,
        "names": [{"name": x.name, "alias": x.asname} for x in node.names],
        **span(node),
    }


def class_fact(node):
    fields = []
    methods = []
    calls = []
    for item in node.body:
        if isinstance(item, (ast.Assign, ast.AnnAssign)):
            fields.append(assignment(item))
        elif isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            methods.append(function(item))
        elif isinstance(item, ast.Expr) and isinstance(item.value, ast.Call):
            calls.append({"value": value(item.value), **span(item)})
    return {
        "name": node.name,
        "bases": [value(x) for x in node.bases],
        "keywords": [{"name": x.arg, "value": value(x.value)} for x in node.keywords],
        "decorators": [value(x) for x in node.decorator_list],
        "fields": fields,
        "methods": methods,
        "calls": calls,
        **span(node),
    }


def analyze(source, filename):
    tree = ast.parse(source, filename=filename, type_comments=True)
    imports = []
    assignments = []
    calls = []
    functions = []
    classes = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports.append(import_fact(node))
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            assignments.append(assignment(node))
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            calls.append({"value": value(node.value), **span(node)})
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(function(node))
        elif isinstance(node, ast.ClassDef):
            classes.append(class_fact(node))
    return {
        "imports": imports,
        "assignments": assignments,
        "calls": calls,
        "functions": functions,
        "classes": classes,
    }


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:
        json.dump({"protocol": RESP, "ok": False, "error": {"code": "INVALID_REQUEST", "message": str(exc)}}, sys.stdout, ensure_ascii=False, sort_keys=True)
        return
    if request.get("protocol") != REQ or not isinstance(request.get("source"), str):
        json.dump({"protocol": RESP, "ok": False, "error": {"code": "INVALID_REQUEST", "message": "expected protocol and string source"}}, sys.stdout, ensure_ascii=False, sort_keys=True)
        return
    filename = request.get("filename") if isinstance(request.get("filename"), str) else "<source>"
    try:
        facts = analyze(request["source"], filename)
    except SyntaxError as exc:
        json.dump({
            "protocol": RESP,
            "ok": False,
            "error": {
                "code": "PYTHON_SYNTAX_ERROR",
                "message": exc.msg,
                "line": exc.lineno,
                "column": exc.offset,
                "end_line": getattr(exc, "end_lineno", None),
                "end_column": getattr(exc, "end_offset", None),
            },
        }, sys.stdout, ensure_ascii=False, sort_keys=True)
        return
    json.dump({
        "protocol": RESP,
        "ok": True,
        "runtime": {"implementation": sys.implementation.name, "version": [sys.version_info.major, sys.version_info.minor, sys.version_info.micro]},
        "facts": facts,
    }, sys.stdout, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


if __name__ == "__main__":
    main()
