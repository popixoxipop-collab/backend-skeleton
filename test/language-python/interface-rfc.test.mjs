import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import * as lib from './baseline-record-lib.mjs';
import * as analyzer from '../../scanners/language/python/analyzer.mjs';
import * as resolver from '../../scanners/language/python/resolver.mjs';
import * as typeShape from '../../scanners/language/python/type-shape.mjs';
import * as modelShape from '../../scanners/language/python/model-shape.mjs';
import * as fastapi from '../../scanners/language/python/fastapi-shadow.mjs';
import * as flask from '../../scanners/language/python/flask-shadow.mjs';
import * as django from '../../scanners/language/python/django-shadow.mjs';

// T06-02: scanners/language/python/INTERFACE_RFC.md is compared with the code in three ways. (1) The vocabulary file stores the
// exports, signatures, defaults, options, error messages, key lists, words and sample-derived tables that the document shows. The
// test compares the file listing, exports, signatures, protocol strings, defaults, options, imports, word literals, object key sets,
// words, diagnostic keys, expressions, module ids, collisions, localities and resolutions with the sources and with calls of the real
// code on inline Python fixtures. The descriptive columns (role, meaning, when, what, takes, returns and similar) are written by hand
// and are not compared. (2) The tables of the document are rendered from the vocabulary by one function (below); each block that
// starts with a table bar or a level 4 heading must equal a rendered block, and a line that starts with a table bar must lie inside
// such a block. (3) Each claim id of the vocabulary has one check below that provokes the behaviour its statement describes. The prose
// is not parsed. A comparison against an undefined side is a problem, an empty sample is a problem, and the negative tests edit copies
// of the vocabulary and of the document text to show that the kinds of drift they edit are reported. The test reads no corpus.
const ROOT = lib.REPO_ROOT;
const DIR = 'scanners/language/python';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const MODS = { analyzer, resolver, 'type-shape': typeShape, 'model-shape': modelShape, 'fastapi-shadow': fastapi, 'flask-shadow': flask, 'django-shadow': django };
const POSIX = process.platform !== 'win32';
const vocab = JSON.parse(read('test/language-python/interface-rfc.vocabulary.json'));
const rfc = read(`${DIR}/INTERFACE_RFC.md`);
const readme = read(`${DIR}/README.md`);
const runtime = lib.runtimeVerdict(await lib.pythonRuntime());

// Collects problems instead of throwing, so one run lists the problems it finds. A comparison with an undefined side is a problem.
function collector() {
	const problems = [];
	let checks = 0;
	const show = (x) => { const t = JSON.stringify(x); return t === undefined ? 'undefined' : t.length > 260 ? `${t.slice(0, 260)}...` : t; };
	return {
		problems,
		get checks() { return checks; },
		eq(what, expected, actual) { checks += 1; if (expected === undefined || actual === undefined || !isDeepStrictEqual(expected, actual)) problems.push(`${what}: expected ${show(expected)} but found ${show(actual)}`); },
		ok(what, condition) { checks += 1; if (condition !== true) problems.push(`${what}: condition does not hold`); },
		throws(what, fn, message) {
			checks += 1;
			let error;
			try { fn(); } catch (e) { error = e; }
			if (!error) problems.push(`${what}: did not throw`);
			else if (error.message !== message) problems.push(`${what}: threw ${show(error.message)} but expected ${show(message)}`);
		},
	};
}
const memo = (fn) => { let box; return () => (box ??= { value: fn() }).value; };
const statics = memo(staticFacts);
const samples = memo(buildSamples);
const withEnv = (patch, fn) => {
	const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
	const set = (env) => { for (const [k, val] of Object.entries(env)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; } };
	set(patch);
	try { return fn(); } finally { set(saved); }
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fakeDir = () => fs.realpathSync(lib.tmpDir('t06-rfc-fake-'));
const NOWHERE = '/nonexistent/python3';
const fixtureText = () => [PY_FACTS, ...[FILE_FIXTURES, RESOLVER_FILES, MODULE_IDENTITY_FILES, TYPE_FILES, MODEL_FILES, FASTAPI_FILES, FLASK_FILES, DJANGO_FILES].flatMap((files) => [...Object.keys(files), ...Object.values(files).map(String)])].join('\n');

// ---------------------------------------------------------------------------
// Rendering: the tables of the document are produced from the vocabulary by this one function. The test requires each rendered
// block to appear in INTERFACE_RFC.md unchanged and each table block of the document to be a rendered one. A table block that is
// edited without the vocabulary no longer equals its rendering.
// ---------------------------------------------------------------------------
//@@RENDER-BEGIN
const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs) => [...xs].sort(cmpText);
const cell = (x) => String(x).replace(/\|/g, '\\|');
const code = (x) => `\`${x}\``;
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const titled = (title, head, rows) => `#### ${title}\n\n${table(head, rows)}`;
function renderTables(v) {
	const out = {};
	out.files = table(['File', 'Role'], v.files.map(([f, r]) => [code(f), r]));
	out.exports = table(['Export', 'File', 'Signature', 'Takes', 'Returns'], v.exports.map(([n, f, sig, takes, returns]) => [code(n), code(f), code(`${n}(${sig})`), takes, returns]));
	out.protocols = table(['Constant', 'Value', 'Use'], v.protocols.map(([n, value, use]) => [code(n), code(value), use]));
	out.defaults = table(['Constant', 'Expression', 'Value', 'Meaning'], v.defaults.map(([n, expr, value, meaning]) => [code(n), code(expr), value, meaning]));
	out.options = table(['Option', 'Applies to', 'Default', 'Accepted', 'Rejected with'], v.options.map(([o, a, d, acc, msg]) => [code(o), a, d === 'none' ? 'none' : code(d), acc, msg]));
	out.errors = table(['Condition', 'Message'], v.errors.map(([c, m]) => [c, code(m)]));
	out.shapes = v.sections.map(([key, title]) => titled(title, ['Object', 'Keys', 'What'], Object.entries(v.shapes).filter(([, s]) => s.section === key).sort(([a], [b]) => cmpText(a, b)).map(([g, s]) => [g, s.keys.map(code).join(', '), s.what]))).join('\n\n');
	out.words = Object.entries(v.words).sort(([a], [b]) => cmpText(a, b)).map(([prop, w]) => titled(`${code(prop)}: ${w.title}`, ['Word', 'Meaning'], Object.entries(w.items).sort(([a], [b]) => cmpText(a, b)).map(([word, meaning]) => [code(word), meaning]))).join('\n\n');
	out.unreachable = table(['Property', 'Word', 'Written in', 'Literal'], v.unreachable.map(([p, w, f, lit]) => [code(p), code(w), code(f), code(lit)]));
	out.diagnostics = table(['Diagnostic (kind, then reason)', 'Keys', 'When'], Object.entries(v.diagnostics).sort(([a], [b]) => cmpText(a, b)).map(([id, d]) => [code(id), d.keys.map(code).join(', '), d.what]));
	out.expressions = table(['Source line', 'Fact'], v.expressions.map(([src, fact]) => [code(src), code(fact)]));
	out.moduleIds = table(['Source path', 'Module id', 'Package id', 'Is a package'], v.moduleIds.map(([p, id, pkg, is]) => [code(p), code(id), pkg === '' ? '(empty)' : code(pkg), String(is)]));
	out.collisions = table(['Module id', 'Sources'], v.collisions.map(([id, srcs]) => [code(id), srcs]));
	out.localities = table(['Module id', 'Locality'], v.localities.map(([m, l]) => [code(m), code(l)]));
	out.resolutions = table(['Function', 'Module', 'Symbol', 'Result'], v.resolutions.map(([fn, m, sym, result]) => [code(fn), code(m), sym === '' ? '(empty string)' : code(sym), code(result)]));
	out.identity = table(['Identifier', 'Strategy', 'Stable within', 'Breaks on', 'Note', 'Checked by'], v.identity.map(([id, ...rest]) => [code(id), ...rest.slice(0, 4), code(rest[4])]));
	out.claims = table(['Id', 'Needs', 'Statement'], v.claims.map(([id, needs, text]) => [code(id), needs, text]));
	out.limits = table(['Id', 'Status', 'Statement', 'Checked by'], v.limits.map(([id, status, text, by]) => [code(id), code(status), text, by === 'stated' ? 'stated, not recomputed' : code(by)]));
	out.baselineLimits = table(['Id in BASELINE.json', 'Status', 'In this document'], v.baselineLimits.map(([id, status, by]) => [code(id), code(status), by === 'not repeated' ? 'not repeated here' : code(by)]));
	out.obligations =table(['Id', 'Owner', 'State', 'Scope', 'Blocks'], v.obligations.map((row) => row.map((x, i) => (i === 0 ? code(x) : x))));
	out.ownership = table(['Scope', 'Owner', 'Role'], v.ownership.map(([pattern, , owner, role]) => [code(pattern), owner, role]));
	out.consumers = table(['Path', 'Use', 'Layer files named'], v.consumers.map(([p, kind, files]) => [code(p), kind, files.map(code).join(', ')]));
	out.recognised = table(['File', 'Names matched', 'For'], v.recognised.map(([f, names, what]) => [code(f), names, what]));
	return out;
}
//@@RENDER-END

// ---------------------------------------------------------------------------
// Samples: calls of the real code on inline, hand-written Python fixtures. Nothing is read from a corpus.
// ---------------------------------------------------------------------------
const lines = (...rows) => `${rows.join('\n')}\n`;
const nest = (n) => `${'['.repeat(n)}1${']'.repeat(n)}`;
const writeTree = (files) => {
	const root = fs.realpathSync(lib.tmpDir('t06-rfc-'));
	for (const [rel, body] of Object.entries(files)) {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, body);
	}
	return root;
};
const analyzeProject = (files, options = {}) => {
	const root = writeTree(files);
	const batch = analyzer.analyzePythonFiles({ repoRoot: root, files: Object.keys(files).filter((f) => /\.pyi?$/.test(f)), ...options });
	return { root, batch, project: resolver.buildPythonProjectFacts(batch.results) };
};

const PY_FACTS = lines(
	'import os', 'from . import x', 'from a.b import c as d, e', 'from m import *',
	'A = 1', 'B = -1', 'B2 = +2', 'C = 1.5', 'D = True', 'E = None', 'F = "s" "t"',
	'G = 12345678901234567890', 'G2 = 9007199254740993', 'G3 = -9007199254740992', 'H = 1e999', 'H2 = -1e999',
	'K = 1j', 'L = b"x"', 'M = ...', 'N = [1, (2, 3), {4}]', 'O = {"k": 1, **P}', 'Q = f(a, b=2, *c, **d)',
	'R = a.b[c]', 'S = int | str', 'T = a if b else c', 'U = lambda: 0', 'V = [x for x in y]', 'W = f"{x}"',
	'X = x.y().z', 'Y: int = 5', 'Z, AA = 1, 2', 'cc.dd = 4', 'NA = ~1', 'NB = not x', 'NC = 1 + 2', 'ND = -x', 'NE = -True',
	`DEEP = ${nest(14)}`, `DEEP12 = ${nest(12)}`,
	'x += 1', 'call_at_top(1)', 'a.b.c(1)', '"docstring"', 'del x', 'assert x', 'pass', 'global gg',
	'if cond:', '    cond_assign = 1', '    cond_call(2)', '    cond_aug += 1', '    import hidden', '    def cond_fn(): pass', '    class CondCls: pass',
	'try:', '    import maybe', 'except ImportError:', '    maybe = None',
	'with ctx() as w:', '    inner = 3',
	'for i in range(3):', '    loop = i',
	'while False:', '    wl = 1',
	'async def af(a, /, b: int = 1, *args, c=2, d: "str" = None, **kw) -> int | None:', '    def nested_fn(): pass', '    return a',
	'@dec', '@dec2(1, k=2)', 'def df(): pass',
	'class K1(Base, metaclass=Meta, flag=True):', '    """doc"""', '    f1: int = 1', '    f2 = "x"', '    f3, f4 = 1, 2',
	'    def meth(self): pass', '    async def ameth(self): pass', '    registry.add(1)', '    class Inner: pass',
	'    if True:', '        hidden_field = 1', '    @property', '    def prop(self): pass',
	'@cdec', 'class K2: pass',
);
const FILE_FIXTURES = {
	'facts.py': PY_FACTS,
	'syntax.py': 'def (:\n',
	'latin.py': '# -*- coding: latin-1 -*-\nx = 1\n',
	'cookie.py': '# coding: nonexistent-enc\nx = 1\n',
	'bad-utf8.py': Buffer.from([0x78, 0x3d, 0x22, 0xff, 0x22, 0x0a]),
	'big.py': ' '.repeat(3000),
};
const RESOLVER_FILES = {
	'pkg/__init__.py': 'class Thing: pass\nexported = 1\n',
	'pkg/thing.py': 'class Inner: pass\n',
	'pkg/other.py': lines(
		'from . import thing', 'from .thing import Inner', 'from .. import up', 'from ...far import nowhere', 'from pkg import Thing',
		'from pkg import thing as t2', 'from pkg.thing import *', 'from os import path as p', 'import os.path', 'import os.path as osp',
		'import pkg.thing', 'import json, sys as s', 'from json import loads', 'from json import dumps', 'import collisions', 'from collisions import cx',
	),
	'collisions.py': 'cx = 1\n',
	'collisions/__init__.py': 'cx = 2\n',
	'cyc_a.py': 'from cyc_b import q\n',
	'cyc_b.py': 'from cyc_a import q\n',
	'amb/__init__.py': 'def name(): pass\n',
	'amb/name.py': 'x = 1\n',
	'user.py': 'from amb import name\n',
	'star.py': 'from pkg import *\nfrom nowhere_at_all import *\n',
};
const RESOLVER_SYMBOLS = ['thing', 'thing.Inner', 'Inner', 'Thing', 't2', 'up', 'nowhere', 'p', 'os', 'osp', 'pkg.thing.Inner', 'pkg', 'loads', 'dumps', 'cx', 'collisions.cx', 'undefinedname', '', 'x.y.z', 'Thing.attr'];
const MODULE_IDENTITY_FILES = {
	'top.py': 'a = 1\n', 'pkg/__init__.py': '', 'pkg/mod.py': 'b = 1\n', 'src/app/main.py': 'd = 1\n', 'my-dir/x.py': 'e = 1\n',
	'a/b.py': 'f = 1\n', 'a/b/__init__.py': 'g = 1\n', 'p.q.py': 'h = 1\n', 'stub.py': 'i = 1\n', 'stub.pyi': 'j: int\n',
};
const TYPE_FILES = {
	'models.py': lines(
		'from typing import Optional, Union, Annotated, Literal, List, Dict, Any, Callable', 'import typing as t',
		'from pydantic import BaseModel, Field', 'class M(BaseModel):',
		'    a: int', '    b: List[int]', '    c: Dict[str, int]', '    d: Optional[str]', '    e: Union[int, str, None]', '    f: int | str | None',
		'    g: "Fwd"', '    h: Annotated[int, Field(gt=0)]', '    i: Literal["a", 1]', '    j: Callable[[int], str]', '    k: t.Optional[int]',
		'    l: Any', '    m: Missing', '    n: foo()', '    o: 1', '    p: x.y.z', '    q: list[dict[str, int]]', '    r: unknown_mod.Thing[int]',
		'    s = 3', '    u: tuple[int, ...]', '    v: None', '    w: foo()[int]',
	),
};
const MODEL_FILES = {
	'm/__init__.py': '',
	'm/base.py': lines(
		'from pydantic import BaseModel, Field', 'from sqlmodel import SQLModel', 'from pydantic_settings import BaseSettings',
		'class Base(BaseModel):', '    id: int = Field(primary_key=True, alias="ID", nullable=False)',
		'class Settings(BaseSettings):', '    url: str',
		'class Ent(SQLModel, table=True):', '    pk: int = Field(default=None, primary_key=True)', '    name: str = Field(default_factory=str)',
		'class Dto(SQLModel):', '    pk: int', 'flag = True', 'class Ent2(SQLModel, table=flag):', '    pk: int', 'class Plain: pass', 'class Unres(missing_base):', '    x: int',
		'class CycA(CycB): pass', 'class CycB(CycA): pass',
	),
	'm/child.py': lines('from .base import Base, Ent', 'from . import base as b', 'class Child(Base):', '    extra: str', 'class Child2(b.Base):', '    extra2: str', 'class Sub(Ent):', '    more: int'),
	'n/other.py': lines('from pydantic import BaseModel', 'class Base(BaseModel):', '    x: int'),
	'o.py': lines('import pydantic', 'class P(pydantic.BaseModel):', '    z: int'),
	'cycle.py': lines('from pydantic import BaseModel', 'class CycA(CycB, BaseModel): pass', 'class CycB(CycA): pass'),
};
const FASTAPI_FILES = {
	'app/__init__.py': '',
	'app/routes.py': lines(
		'from fastapi import APIRouter, FastAPI', 'from . import other', 'import x_unknown', 'import m1',
		'router = APIRouter(prefix="/v1")', 'dyn = APIRouter(prefix=PREFIX)', 'noprefix = APIRouter()', 'app = FastAPI()',
		'@router.get("/items")', 'def list_items(): pass', '@router.post(path_var)', 'def create(): pass', '@dyn.get("/x")', 'def dynx(): pass',
		'@missing.get("/y")', 'def missingy(): pass', '@router.get(path="/kw")', 'def kwpath(): pass', '@router.options("/o")', 'def opts(): pass',
		'@router.api_route("/ar")', 'def ar(): pass', '@app.get("/app")', 'def appget(): pass', '@noprefix.delete("/d/")', 'def dele(): pass',
		'app.include_router(router, prefix="/api")', 'app.include_router(other.r)', 'app.include_router(getattr(a, "b"))', 'app.include_router(x_unknown.r)',
		'app.include_router(router, prefix=P)', 'app.include_router(router=router)', 'app.include_router()', 'app.include_router(m1.thing)', 'other.include_router(router)', 'router.include_router(other.r, prefix="/sub")',
	),
	'app/other.py': 'from fastapi import APIRouter\nr = APIRouter()\n',
	'm1.py': 'thing = 1\n',
	'models.py': lines('from sqlmodel import SQLModel, Field', 'class Item(SQLModel, table=True):', '    id: int = Field(primary_key=True)', 'class ItemPublic(SQLModel):', '    id: int'),
};
const FLASK_FILES = {
	'f.py': lines(
		'from flask import Flask, Blueprint', 'app = Flask(__name__)', 'bp = Blueprint("bp", __name__, url_prefix="/bp")', 'dynbp = Blueprint("d", __name__, url_prefix=PREFIX)',
		'@app.route("/a")', 'def a(): pass', '@app.route("/b", methods=["post", "GET", "get"])', 'def b(): pass', '@app.route("/c", methods=M)', 'def c(): pass',
		'@app.route("/c2", methods=[M])', 'def c2(): pass', '@app.get("/d")', 'def d(): pass', '@bp.route("/e", methods=("PUT",))', 'def e(): pass',
		'@dynbp.route("/f")', 'def f(): pass', '@zz.route("/g")', 'def g(): pass', '@app.route(P)', 'def h(): pass', '@app.route(rule="/i")', 'def i(): pass',
		'@bp.post("/j")', 'def j_(): pass', '@app.add_url_rule("/k")', 'def k(): pass', '@app.route("/s", methods={"get"})', 'def s(): pass',
		'@app.route', 'def l(): pass', '@app.options("/o")', 'def o(): pass',
	),
};
const DJANGO_FILES = {
	'site/__init__.py': '',
	'site/urls.py': lines(
		'from django.urls import path, re_path, include', 'from . import views', 'from .views import ItemView, func_view', 'import notproj',
		'urlpatterns = [',
		'    path("items/", views.list_items, name="items"),', '    path("cls/", ItemView.as_view(), name="cls"),', '    path("cls2/", views.Other.as_view()),',
		'    re_path(r"^re/$", func_view, name=NAME),', '    path("api/", include("blog.urls")),', '    re_path(r"^reg/", include("blog.urls")),',
		'    path("dyn/" + X, func_view),', '    path(P, func_view),', '    path("nov/"),', '    path("call/", make_view()),', '    path("lam/", lambda r: r),',
		'    path("ext/", notproj.view),', '    path("undef/", undefined_view),', '    path("inc/", include(INC)),', '    path("miss/", include("nowhere.urls")),', '    path("nc/", include("noconf.views")),', '    path("tuple/", include(("blog.urls", "ns"))),',
		'    something_else("x", func_view),', '    foo,', '    unknown_path("x", func_view),', '    path("kwview/", view=func_view),',
		'    path("namekw/", func_view, name="nk"),', '    path("namepos/", func_view, {}, "np"),', ']',
	),
	'site/views.py': 'def list_items(r): pass\nclass Other: pass\nclass ItemView: pass\ndef func_view(r): pass\n',
	'blog/__init__.py': '',
	'blog/urls.py': lines('from django.urls import path, include', 'from site import views', 'urlpatterns = [path("posts/", views.list_items), path("cyc/", include("cyc.urls"))]'),
	'cyc/urls.py': lines('from django.urls import path, include', 'urlpatterns = [path("back/", include("blog.urls"))]'),
	'mut/urls.py': lines('from django.urls import path', 'urlpatterns = [path("m/", f)]', 'urlpatterns += [path("n/", f)]'),
	'mut2/urls.py': lines('from django.urls import path', 'urlpatterns = [path("m/", f)]', 'urlpatterns.append(path("n/", f))'),
	'mut3/urls.py': lines('from django.urls import path', 'urlpatterns = [path("m/", f)]', 'if DEBUG:', '    urlpatterns.append(path("n/", f))'),
	'dup/urls.py': lines('from django.urls import path', 'urlpatterns = [path("m/", f)]', 'urlpatterns = [path("n/", f)]'),
	'dyn/urls.py': lines('from django.urls import path', 'urlpatterns = make()'),
	'empty/urls.py': 'urlpatterns = []\n',
	'noconf/views.py': 'x = 1\n',
};
// Hand-fed: the shape summarizeLegacyFastApi reads from the legacy scanner. The real legacy scan is compared in python-fastapi-shadow.test.mjs.
const LEGACY_SCAN = { modules: [{ module: 'app.routes', controllers: [{ endpoints: [{ verb: 'GET', path: '/v1/items', method: 'list_items', line: 9 }, { verb: 'GET', path: '/gone', method: 'gone', line: 1 }] }], entities: [{ className: 'Item', idField: 'id' }], dtos: [{ className: 'ItemPublic' }, { className: 'Gone' }] }] };

// Words and shapes are observed by property name; open sets (operator names of augmented assignments, node and type names,
// encodings) are not listed because the code does not close them.
const WORD_PROPS = ['code', 'container', 'family', 'kind', 'locality', 'methodSemantics', 'methodsStatus', 'nameStatus', 'prefixStatus', 'reason', 'receiverKind', 'status', 'syntax', 'tableStatus'];
const DIAGNOSTIC_KINDS = ['django-urlconf', 'django-urlpattern', 'fastapi-endpoint', 'fastapi-mount', 'flask-route'];

function observeWords(value, into) {
	if (Array.isArray(value)) { value.forEach((x) => observeWords(x, into)); return; }
	if (!value || typeof value !== 'object' || value instanceof Map) return;
	for (const [key, item] of Object.entries(value)) {
		if (WORD_PROPS.includes(key) && typeof item === 'string') {
			if (!into.has(key)) into.set(key, new Set());
			into.get(key).add(item);
		}
		if (typeof item === 'object') observeWords(item, into);
	}
}

function valueShapes(node, add) {
	if (!node || typeof node !== 'object') return;
	add(`value ${node.kind}`, node);
	if (node.kind === 'sequence') node.items.forEach((x) => valueShapes(x, add));
	if (node.kind === 'mapping') node.entries.forEach((e) => { add('mapping entry', e); valueShapes(e.key, add); valueShapes(e.value, add); });
	if (node.kind === 'call') {
		valueShapes(node.callee, add);
		node.args.forEach((x) => valueShapes(x, add));
		node.keywords.forEach((k) => { add('call keyword', k); valueShapes(k.value, add); });
	}
	if (node.kind === 'subscript') { valueShapes(node.base, add); valueShapes(node.slice, add); }
	if (node.kind === 'binary') { valueShapes(node.left, add); valueShapes(node.right, add); }
}
function assignmentShapes(a, add, group) {
	add(group, a);
	valueShapes(a.annotation, add);
	valueShapes(a.value, add);
}
function functionShapes(fn, add) {
	add('function fact', fn);
	fn.decorators.forEach((d) => valueShapes(d, add));
	fn.arguments.forEach((a) => { add('argument fact', a); valueShapes(a.annotation, add); valueShapes(a.default, add); });
	valueShapes(fn.returns, add);
}
function factShapes(facts, add) {
	add('facts', facts);
	facts.imports.forEach((i) => { add('import fact', i); i.names.forEach((n) => add('imported name', n)); });
	facts.assignments.forEach((a) => assignmentShapes(a, add, 'assignment fact'));
	facts.augmentedAssignments.forEach((a) => { add('augmented assignment fact', a); valueShapes(a.value, add); });
	facts.calls.forEach((c) => { add('call statement fact', c); valueShapes(c.value, add); });
	facts.controlFlowMutations.forEach((m) => { add(`control-flow mutation ${m.kind}`, m); valueShapes(m.value, add); valueShapes(m.annotation, add); });
	facts.functions.forEach((fn) => functionShapes(fn, add));
	facts.classes.forEach((c) => {
		add('class fact', c);
		[...c.bases, ...c.decorators].forEach((x) => valueShapes(x, add));
		c.keywords.forEach((k) => { add('class keyword', k); valueShapes(k.value, add); });
		c.fields.forEach((f) => assignmentShapes(f, add, 'assignment fact'));
		c.methods.forEach((m) => functionShapes(m, add));
		c.calls.forEach((x) => { add('call statement fact', x); valueShapes(x.value, add); });
	});
}
function typeShapes(t, add) {
	if (!t || typeof t !== 'object') return;
	add(`type ${t.kind}`, t);
	if (t.kind === 'union') t.options.forEach((x) => typeShapes(x, add));
	if (t.kind === 'annotated') typeShapes(t.base, add);
	if (t.kind === 'generic') { typeShapes(t.base, add); t.args.forEach((x) => typeShapes(x, add)); }
	if (t.kind === 'annotated') t.metadata.forEach((x) => valueShapes(x, add));
	if (t.kind === 'literal') t.values.forEach((x) => valueShapes(x, add));
}

// A stand-in interpreter (POSIX shell script): it answers the version probe with `probe`, then runs `body` for any other call.
const makeFake = (dir, name, body, probe = '3.12.0', consumeInput = true) => {
	const file = path.join(dir, name);
	const consume = consumeInput ? '/bin/cat >/dev/null\n' : '';
	fs.writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "-c" ]; then echo ${probe}; exit 0; fi; done\n${consume}${body}\n`);
	fs.chmodSync(file, 0o755);
	return file;
};

// A stand-in interpreter that notes every call it gets in the file calls.txt next to itself: the line "probe" for the version probe and the line "run" for any other call. The note is made before the probe is answered. The script does not contain the path of its directory: it finds the directory when it runs, from its own location.
const makeRecorder = (dir, name, probe = '3.12.0') => {
	const file = path.join(dir, name);
	const script = ['#!/bin/sh', 'd="${0%/*}"', `for a in "$@"; do if [ "$a" = "-c" ]; then echo probe >> "$d/calls.txt"; echo ${probe}; exit 0; fi; done`, 'echo run >> "$d/calls.txt"', 'exit 0', ''];
	fs.writeFileSync(file, script.join('\n'));
	fs.chmodSync(file, 0o755);
	return file;
};
const callsOf = (dir) => { const file = path.join(dir, 'calls.txt'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []; };

// The analyzer probes a stand-in with a 1500 ms limit. On a heavily loaded host that probe can time out and the stand-in then reads as unavailable, so such a call is repeated (at most twice more). A stand-in that is really refused is refused every time.
const attempts = (call) => { let result = call(); for (let n = 1; n < 3 && result.error?.code === 'PYTHON_RUNTIME_UNAVAILABLE'; n += 1) result = call(); return result; };

// Returns null when no approved interpreter exists, because every sample below needs the real helper.
function buildSamples() {
	const runtime = analyzer.findPythonRuntime();
	if (!runtime) return null;
	const outputs = {};
	const shapes = new Map();
	const diagnostics = [];
	const add = (group, object) => { if (!shapes.has(group)) shapes.set(group, []); shapes.get(group).push(object); };
	const diag = (u) => { diagnostics.push(u); };

	// 1. analyzePythonFile and the helper facts
	const root = writeTree(FILE_FIXTURES);
	const one = (file, options = {}) => analyzer.analyzePythonFile({ repoRoot: root, file, ...options });
	const record = (name, result) => {
		outputs[name] = result;
		add(result.ok ? 'file result ok' : 'file result failure', result);
		add('source reference', result.source);
		if (result.error) add(result.error.code === 'PYTHON_SYNTAX_ERROR' ? 'error with position' : 'error', result.error);
		if (result.runtime) add('helper runtime', result.runtime);
		return result;
	};
	const facts = record('facts', one('facts.py'));
	factShapes(facts.facts, add);
	for (const name of ['syntax', 'latin', 'cookie', 'bad-utf8']) record(name, one(`${name}.py`));
	record('too-large', one('big.py', { maxSourceBytes: 1024 }));
	record('no-runtime', one('latin.py', { pythonCommand: '/nonexistent/python3' }));
	const batch = analyzer.analyzePythonFiles({ repoRoot: root, files: ['syntax.py', 'latin.py', 'big.py'], maxSourceBytes: 2048 });
	outputs.batch = batch;
	add('batch result', batch);
	if (batch.runtime) add('runtime handle', batch.runtime);
	const empty = analyzer.analyzePythonFiles({ repoRoot: root, files: [] });
	outputs.emptyBatch = empty;
	add('batch result', empty);
	add('runtime handle', runtime);
	outputs.runtime = runtime;

	if (process.platform !== 'win32') {
		const dir = fs.realpathSync(lib.tmpDir('t06-rfc-fake-'));
		const fake = (name, body) => makeFake(dir, name, body);
		record('fake-bad-json', attempts(() => one('latin.py', { pythonCommand: fake('bad-json', 'echo not-json') })));
		record('fake-envelope', attempts(() => one('latin.py', { pythonCommand: fake('envelope', 'echo \'{"protocol":"x","ok":true}\'') })));
		record('fake-exit', attempts(() => one('latin.py', { pythonCommand: fake('exit3', 'echo boom >&2; exit 3') })));
		record('fake-slow', attempts(() => one('latin.py', { pythonCommand: fake('slow', 'exec sleep 5'), timeoutMs: 150 })));
		record('fake-flood', attempts(() => one('latin.py', { pythonCommand: fake('flood', 'i=0; while [ $i -lt 9000 ]; do echo 123456789; i=$((i+1)); done'), maxBuffer: 65536 })));
	}

	// 2. resolver
	const R = analyzeProject(RESOLVER_FILES);
	outputs.resolverBatch = R.batch.ok;
	add('project', R.project);
	R.project.collisions.forEach((c) => add('collision', c));
	for (const mod of R.project.list()) {
		add('module entry', mod);
		for (const rec of mod.importResolutions) { add(`import resolution ${rec.kind}`, rec); (outputs.importRecords ??= []).push(rec); }
	}
	outputs.resolutions = RESOLVER_SYMBOLS.map((sym) => resolver.resolvePythonSymbol(R.project, 'pkg.other', sym));
	outputs.resolutionsMore = [
		resolver.resolvePythonSymbol(R.project, 'cyc_a', 'q'), resolver.resolvePythonSymbol(R.project, 'user', 'name'),
		resolver.resolvePythonSymbol(R.project, 'no.such', 'x'), resolver.resolvePythonSymbol(R.project, 'pkg.other', 5),
		resolver.resolveValueSymbol(R.project, 'pkg.other', { kind: 'constant', value: 1 }), resolver.resolveValueSymbol(R.project, 'pkg.other', null),
	];
	for (const r of [...outputs.resolutions, ...outputs.resolutionsMore]) {
		add(r.status === 'resolved' ? 'resolution resolved' : (r.reason ? `resolution ${r.reason}` : (r.locality ? 'resolution unknown with locality' : (r.value !== undefined ? 'resolution unknown value' : 'resolution unknown bare'))), r);
	}
	const ids = analyzeProject(MODULE_IDENTITY_FILES);
	outputs.moduleIds = ids.project.list().map((m) => [m.source.path, m.moduleId, m.packageId, m.isPackage]);
	outputs.moduleCollisions = ids.project.collisions;
	outputs.localities = ['a.b', 'stub', 'nothere'].map((m) => [m, ids.project.moduleLocality(m)]);
	outputs.nonOk = resolver.buildPythonProjectFacts([{ ok: false, source: { path: 'x.py' } }, null, { ok: true, source: { path: 'y.py' }, facts: { imports: [], classes: [], functions: [], assignments: [] } }]).list().map((m) => m.moduleId);

	// 3. type facts and models
	const T = analyzeProject(TYPE_FILES);
	const typed = typeShape.annotatePythonModelTypes(T.project, modelShape.projectPythonModels(T.project));
	outputs.typed = typed;
	typed[0].fields.forEach((f) => typeShapes(f.typeFact, add));
	const M = analyzeProject({ ...MODEL_FILES, ...TYPE_FILES });
	outputs.models = modelShape.projectPythonModels(M.project);
	for (const m of outputs.models) {
		add('model', m);
		add('model bases', m.bases);
		m.fields.forEach((f) => { add('model field', f); add('field metadata', f.metadata); });
	}
	typed[0].fields.forEach((f) => add('annotated model field', f));

	// 4. framework shadows
	const F = analyzeProject(FASTAPI_FILES);
	outputs.fastapi = fastapi.buildFastApiShadow(F.project);
	add('fastapi shadow', outputs.fastapi);
	outputs.fastapi.endpoints.forEach((e) => add('fastapi endpoint', e));
	outputs.fastapi.mounts.forEach((m) => { add('fastapi mount', m); add(m.child.status ? 'mount child unknown' : 'mount child resolved', m.child); });
	outputs.fastapi.entities.forEach((e) => add('fastapi entity', e));
	outputs.fastapi.dtos.forEach((d) => add('fastapi dto', d));
	outputs.fastapi.unknowns.forEach(diag);
	outputs.parity = fastapi.diffFastApiShadow(LEGACY_SCAN, outputs.fastapi);
	add('parity report', outputs.parity);
	add('parity counts', outputs.parity.counts);
	add('parity side counts', outputs.parity.counts.legacy);
	for (const group of Object.values(outputs.parity.differences)) add('parity difference', group);
	outputs.legacySummary = fastapi.summarizeLegacyFastApi(LEGACY_SCAN);

	const K = analyzeProject(FLASK_FILES);
	outputs.flask = flask.buildFlaskRouteShadow(K.project);
	add('flask shadow', outputs.flask);
	outputs.flask.registrations.forEach((r) => add('flask registration', r));
	outputs.flask.declarations.forEach((d) => add('flask declaration', d));
	outputs.flask.unknowns.forEach(diag);

	const D = analyzeProject(DJANGO_FILES);
	outputs.django = django.buildDjangoUrlShadow(D.project);
	add('django shadow', outputs.django);
	outputs.django.registrations.forEach((r) => { add('django registration', r); r.patternSegments.forEach((s) => add('pattern segment', s)); add(`view target ${r.target.kind}`, r.target); });
	outputs.django.includes.forEach((i) => { add('django include', i); add('pattern segment', i.prefix); });
	outputs.django.unknowns.forEach(diag);

	outputs.batchesOk = [R.batch.ok, T.batch.ok, M.batch.ok, F.batch.ok, K.batch.ok, D.batch.ok];
	const observed = new Map();
	observeWords(outputs, observed);
	return { runtime, outputs, shapes, diagnostics, observed, projects: { resolver: R.project, models: M.project, fastapi: F.project, flask: K.project, django: D.project, ids: ids.project } };
}

// ---------------------------------------------------------------------------
// Derived tables: what the vocabulary stores for the samples and for the sources. The generator of the vocabulary (not shipped)
// and this test call the same functions, so the stored sample tables are compared with tables recomputed by those functions.
// ---------------------------------------------------------------------------
const EXPRESSION_VARS = ['A', 'B', 'B2', 'C', 'D', 'E', 'F', 'G', 'G2', 'G3', 'H', 'H2', 'K', 'L', 'M', 'S', 'NA', 'NB', 'NC', 'ND', 'NE', 'T', 'U', 'V', 'W', 'X'];
const RESOLUTION_ROWS = [
	...RESOLVER_SYMBOLS.map((sym) => ['resolvePythonSymbol', 'pkg.other', sym === '' ? '(empty string)' : sym]),
	['resolvePythonSymbol', 'cyc_a', 'q'], ['resolvePythonSymbol', 'user', 'name'], ['resolvePythonSymbol', 'no.such', 'x'], ['resolvePythonSymbol', 'pkg.other', '(the number 5)'],
	['resolveValueSymbol', 'pkg.other', '(a constant value)'], ['resolveValueSymbol', 'pkg.other', '(null)'],
];
// Keys of a group of objects, sorted; a key that is missing from some of the objects ends with a question mark.
const keysOf = (objects) => {
	const counts = new Map();
	for (const o of objects) for (const k of Object.keys(o)) counts.set(k, (counts.get(k) ?? 0) + 1);
	return [...counts].map(([k, n]) => (n === objects.length ? k : `${k}?`)).sort((a, b) => cmpText(a.replace(/\?$/, ''), b.replace(/\?$/, '')));
};
// Import specifiers of a module source (comments ignored) and the imports that cannot be listed (computed import, require).
function importsOf(source) {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
	const specs = [...code.matchAll(/\b(?:import|export)\b[^'"`;()]*?\bfrom\s*(['"])([^'"\n]+)\1|\bimport\s*(['"])([^'"\n]+)\3|\bimport\s*\(\s*(['"])([^'"\n]+)\5\s*\)/g)].map((m) => m[2] ?? m[4] ?? m[6]);
	const opaque = [...code.matchAll(/\bimport\s*\((?!\s*['"][^'"\n]+['"]\s*\))|\brequire\s*\(|\bcreateRequire\b/g)].map((m) => m[0]);
	return { specs, opaque };
}
const normalizeSig = (text) => text.replace(/\s+/g, ' ').replace(/,\s*\}/g, ' }').trim();
const signaturesOf = (source) => Object.fromEntries([...source.matchAll(/export function (\w+)\(([^)]*)\)/g)].map((m) => [m[1], normalizeSig(m[2])]));
// The options object of a signature: [[name, default or null]], or null when the function takes positional parameters.
const optionsOf = (sig) => {
	const m = /^\{ (.*) \} = \{\}$/.exec(sig);
	return m ? m[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => { const [name, ...rest] = p.split('='); return [name.trim(), rest.length ? rest.join('=').trim() : null]; }) : null;
};

function staticFacts() {
	const sources = Object.fromEntries(Object.keys(MODS).map((m) => [m, read(`${DIR}/${m}.mjs`)]));
	const helper = read(`${DIR}/ast-helper.py`);
	return {
		sources,
		helper,
		signatures: Object.assign({}, ...Object.values(sources).map(signaturesOf)),
		loads: Object.fromEntries(Object.entries(sources).map(([m, text]) => [m, importsOf(text)])),
		defaults: [...sources.analyzer.matchAll(/^const (DEFAULT_\w+) = ([^;]+);/gm)].map((m) => [m[1], m[2], m[2].split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1)]),
		helperImports: sorted([...helper.matchAll(/^import (\w+)$/gm)].map((m) => m[1])),
		helperProtocols: { request: /^REQ = "([^"]+)"/m.exec(helper)?.[1], response: /^RESP = "([^"]+)"/m.exec(helper)?.[1] },
		listing: fs.readdirSync(path.join(ROOT, DIR), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
	};
}

// Tables recomputed from the samples (an interpreter is needed).
function deriveRows(s) {
	const o = s.outputs;
	const groups = new Map();
	for (const u of s.diagnostics) {
		const id = `${u.kind} ${u.reason}`;
		if (!groups.has(id)) groups.set(id, []);
		groups.get(id).push(u);
	}
	const assigns = o.facts.facts.assignments;
	const all = [...o.resolutions, ...o.resolutionsMore];
	return {
		shapes: Object.fromEntries([...s.shapes].map(([g, objects]) => [g, keysOf(objects)])),
		words: Object.fromEntries(WORD_PROPS.map((p) => [p, sorted(s.observed.get(p) ?? [])])),
		diagnostics: Object.fromEntries([...groups].map(([id, us]) => [id, keysOf(us)])),
		expressions: EXPRESSION_VARS.map((name) => [PY_FACTS.split('\n').find((l) => l.startsWith(`${name} = `)), JSON.stringify(assigns.find((a) => a.targets.length === 1 && a.targets[0] === name)?.value)]),
		module_ids: o.moduleIds,
		collisions: o.moduleCollisions.map((c) => [c.moduleId, c.sources.join(', ')]),
		localities: o.localities,
		resolutions: RESOLUTION_ROWS.map((row, i) => [...row, JSON.stringify(all[i])]),
	};
}

// ---------------------------------------------------------------------------
// Problem functions: each returns a collector; the tests assert that it has checked something and found nothing, and the negative
// tests call them with an edited copy of the vocabulary or of the document text and assert the named problem.
// ---------------------------------------------------------------------------
const TITLE = '# Python analysis layer: interface RFC';
const HEADINGS = [
	'Purpose and non-goals', 'Scope', 'Inputs and outputs', 'Identity', 'Unknown, partial and unsupported', 'Safety', 'Checked statements',
	'Remaining limits', 'Promotion gates', 'File ownership', 'How this document stays true',
];
const VOCABULARY_KEYS = [
	'baselineLimits', 'claims', 'collisions', 'consumers', 'defaults', 'diagnostics', 'errors', 'exports', 'expressions', 'files', 'identity', 'limits', 'localities', 'moduleIds',
	'obligations', 'options', 'ownership', 'protocols', 'recognised', 'resolutions', 'rfc', 'sections', 'shapes', 'terms', 'unreachable', 'words',
];
const NEEDS = ['none', 'static', 'posix', 'python'];
// Text that must not appear in the document or the README: references by number, digests, commit ids, absolute host paths.
const BANNED = [
	[/#\d/, 'a number sign followed by a digit'], [/\bPR\s*\d/i, 'a pull request number'], [/\/pull\/\d/, 'a pull request link'], [/\/issues\/\d/, 'an issue link'],
	[/GH-\d/, 'a GH reference'], [/refs\/pull/, 'a pull ref'], [/\b[0-9a-f]{40}\b/, 'a 40-digit hex string'], [/\b[0-9a-f]{64}\b/, 'a 64-digit hex string'],
	[/\/Users\//, 'a home directory path'], [/\/private\//, 'a private host path'], [/\/tmp\//, 'a temporary directory path'], [new RegExp(`${String.fromCharCode(92, 92)}u`), 'a backslash followed by u'],
];
// Sentences that an earlier draft of the document wrote and that were too general or no longer true; the document must not say them again.
const SUPERSEDED = [
	[/Two bindings of one name keep the later one/, 'that any two bindings of one name keep the later one'],
	[/the later binding wins, as in Python/, 'that the later binding of an import alias wins, as in Python'],
	[/Rebound class names and import aliases keep only the last binding/, 'that rebound class names and import aliases keep only the last binding'],
	[/base does not resolve to a known family is not a model/, 'that a class whose base does not resolve is not a model'],
	[/class with an unresolved base is absent from the models/, 'that a class with an unresolved base is absent from the models'],
	[/tried only where the process cannot read a file of mode 000/, 'that the unreadable-file case is tried only where the process cannot read a file of mode 000'],
	[/and no result is returned for that call \(claim `argument-errors-are-thrown-not-returned`\)/, 'that the claim for argument errors tries the unreadable-file case'],
];
// Words that the sources write directly after a word property but that are not output words; every entry must still be written. The router kind is a descriptor kept inside fastapi-shadow.mjs; the three status words are returned by internal readers of django-shadow.mjs and model-shape.mjs (the urlpatterns reasons are built from some of them).
const INTERNAL = { kind: ['router'], status: ['dynamic', 'mutated', 'verified'] };
// File names that the examples in the tables mention and that only the checks create.
const CLAIM_FIXTURE_NAMES = ['real.py'];
const SPLIT = /[\s`|(),;{}[\]]+/;
const IDENT = /^(?:[a-z]+[A-Z]\w*|[a-z]+_\w+|[A-Z][A-Z0-9]*_\w+)$/;
const rawTokens = (text) => text.split(SPLIT).map((t) => t.replace(/[.:]+$/, '')).filter(Boolean);
const identTokens = (text) => rawTokens(text).map((t) => t.replace(/^['"*]+|['"*]+$/g, '')).filter((t) => IDENT.test(t));
const groundWords = memo(() => new Set([...Object.values(statics().sources), statics().helper, fixtureText(), read('test/language-python/baseline-record-lib.mjs')].join('\n').match(/\w+/g)));
const head = (block) => (block.length > 90 ? `${block.slice(0, 90)}...` : block);
const PATH_START = /^(?:scanners|adapters|test|next|scripts|\.github)\//;

function textProblems(c, v, what, text) {
	for (const [re, why] of BANNED) c.ok(`${what} contains no ${why}`, !re.test(text));
	c.eq(`${what}: identifier-like words that no source, helper or fixture contains`, [], sorted([...new Set(identTokens(text))].filter((t) => !groundWords().has(t))));
	const known = new Set([...v.claims.map((x) => x[0]), ...v.limits.map((x) => x[0]), ...v.baselineLimits.map((x) => x[0]), ...Object.values(v.words).flatMap((w) => Object.keys(w.items)), ...Object.keys(v.diagnostics).flatMap((x) => x.split(' '))]);
	c.eq(`${what}: hyphenated names in backticks that are no claim, limit, baseline limit, word or diagnostic`, [], sorted([...new Set([...text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+){2,})`/g)].map((x) => x[1]))].filter((x) => !known.has(x))));
	const citable = new Set([...v.claims.map((x) => x[0]), ...v.limits.map((x) => x[0]), ...v.baselineLimits.map((x) => x[0])]);
	const cited = [...text.matchAll(/\b(?:claims?|limits?) ((?:`[^`\n]+`(?:, and | and |, )?)+)/g)].flatMap((x) => [...x[1].matchAll(/`([^`\n]+)`/g)].map((y) => y[1]));
	c.ok(`${what}: some ids are cited after the word claim or limit`, text.length < 3000 || cited.length > 20);
	c.eq(`${what}: ids cited after the word claim or limit that are no claim, limit or baseline limit`, [], sorted([...new Set(cited)].filter((x) => !citable.has(x))));
	const names = new Set([...statics().listing, ...fs.readdirSync(path.join(ROOT, 'test/language-python')), ...CLAIM_FIXTURE_NAMES]);
	for (const files of [FILE_FIXTURES, RESOLVER_FILES, MODULE_IDENTITY_FILES, TYPE_FILES, MODEL_FILES, FASTAPI_FILES, FLASK_FILES, DJANGO_FILES]) for (const key of Object.keys(files)) { names.add(key); names.add(path.posix.basename(key)); }
	for (const o of v.ownership) if (!o[1].includes('/')) names.add(o[1]);
	const scopes = new Set(v.ownership.map((o) => o[0]).filter((p) => p.endsWith('/**')));
	const tokens = rawTokens(text);
	for (const t of new Set(tokens.filter((x) => PATH_START.test(x)))) {
		if (t.includes('*')) c.ok(`${what}: wildcard ${t} is an ownership scope of the table`, scopes.has(t));
		else c.ok(`${what}: cited path ${t} exists`, fs.existsSync(path.join(ROOT, t)));
	}
	for (const t of new Set(tokens.filter((x) => !x.includes('/') && /^[\w.-]+\.(?:mjs|md|json|py|pyi)$/.test(x)))) c.ok(`${what}: file name ${t} is a layer file, a test file or a fixture file`, names.has(t));
}

function codeProblems(v) {
	const c = collector();
	const st = statics();
	c.eq('vocabulary keys', VOCABULARY_KEYS, sorted(Object.keys(v)));
	c.eq('files: vocabulary vs directory listing', sorted(v.files.map((f) => f[0])), sorted(st.listing));
	c.eq('directory entries that are not files', [], fs.readdirSync(path.join(ROOT, DIR), { withFileTypes: true }).filter((e) => !e.isFile()).map((e) => e.name));
	c.eq('export rows that name no layer module', [], v.exports.filter((e) => !Object.hasOwn(MODS, e[1].replace(/\.mjs$/, ''))).map((e) => e[0]));
	for (const [stem, mod] of Object.entries(MODS)) {
		const rows = v.exports.filter((e) => e[1] === `${stem}.mjs`);
		c.eq(`${stem}.mjs export names`, sorted([...rows.map((r) => r[0]), ...(stem === 'analyzer' ? v.protocols.map((p) => p[0]) : [])]), sorted(Object.keys(mod)));
		for (const [name, , signature] of rows) {
			c.ok(`${stem}.mjs ${name} is a function`, typeof mod[name] === 'function');
			c.eq(`${stem}.mjs ${name} signature`, signature, st.signatures[name]);
		}
	}
	for (const [name, value] of v.protocols) c.eq(`${name} value`, value, MODS.analyzer[name]);
	c.eq('helper protocol constants (request, response)', { request: v.protocols.find((p) => p[0] === 'PYTHON_AST_REQUEST_PROTOCOL')?.[1], response: v.protocols.find((p) => p[0] === 'PYTHON_AST_RESPONSE_PROTOCOL')?.[1] }, st.helperProtocols);
	c.eq('bskel.*/N strings written in the sources and the helper', sorted(v.protocols.map((p) => p[1])), sorted([...new Set([...Object.values(st.sources), st.helper].join('\n').match(/bskel\.[a-z0-9-]+\.[a-z0-9-]+\/\d+/g) ?? [])]));
	c.eq('DEFAULT_ constants (name, expression, value)', st.defaults, v.defaults.map((d) => d.slice(0, 3)));
	const derived = new Map();
	for (const [fn, sig] of Object.entries(st.signatures)) for (const [name, def] of optionsOf(sig) ?? []) {
		if (!derived.has(name)) derived.set(name, { fns: [], defaults: new Set() });
		derived.get(name).fns.push(fn);
		derived.get(name).defaults.add(def ?? 'none');
	}
	c.eq('option names', sorted(v.options.map((o) => o[0])), sorted([...derived.keys()]));
	for (const [option, appliesTo, def] of v.options) {
		c.eq(`option ${option}: functions that take it`, derived.get(option)?.fns.join(', '), appliesTo);
		c.eq(`option ${option}: default`, derived.has(option) ? [...derived.get(option).defaults] : undefined, [def]);
	}
	for (const [stem, { specs, opaque }] of Object.entries(st.loads)) {
		c.eq(`${stem}.mjs imports that cannot be listed`, [], opaque);
		c.eq(`${stem}.mjs import specifiers that are neither node: built-ins nor layer files`, [], specs.filter((s) => !(s.startsWith('node:') || (s.startsWith('./') && st.listing.includes(s.slice(2))))));
	}
	return c;
}

// Words and codes written in the sources are compared with the vocabulary; words the samples cannot reach must be declared as unreachable.
function codeWordProblems(v) {
	const c = collector();
	const st = statics();
	const text = [...Object.values(st.sources), st.helper].join('\n');
	for (const prop of WORD_PROPS) {
		const known = Object.keys(v.words[prop]?.items ?? {});
		const internal = INTERNAL[prop] ?? [];
		const found = new Set([...text.matchAll(new RegExp(`["']?\\b${prop}\\b["']?\\s*:\\s*["']([^"'\\n]*)["']`, 'g'))].map((m) => m[1]));
		c.eq(`${prop}: literals written after the property name that the vocabulary does not name`, [], sorted([...found].filter((w) => !known.includes(w) && !internal.includes(w))));
		c.eq(`${prop}: internal literals that are no longer written`, [], internal.filter((w) => !found.has(w)));
		c.eq(`${prop}: internal literals that the vocabulary names`, [], internal.filter((w) => known.includes(w)));
	}
	const codes = new Set([...text.matchAll(/\b(PYTHON_[A-Z0-9_]+|INVALID_REQUEST)\b/g)].map((m) => m[1]).filter((w) => !v.protocols.some((p) => p[0] === w)));
	c.eq('code words written in the sources and the helper', sorted(Object.keys(v.words.code.items).filter((w) => /^(?:PYTHON_[A-Z0-9_]+|INVALID_REQUEST)$/.test(w))), sorted([...codes]));
	for (const [prop, word, file, literal] of v.unreachable) {
		const where = file.endsWith('.py') ? st.helper : st.sources[file.replace(/\.mjs$/, '')];
		c.ok(`${file} writes ${literal}`, where?.includes(literal) === true);
		c.ok(`unreachable word ${prop} ${word} is named by the vocabulary`, Object.hasOwn(v.words[prop]?.items ?? {}, word));
	}
	return c;
}

function sampleProblems(v, s = samples()) {
	const c = collector();
	const d = deriveRows(s);
	const want = Object.fromEntries(Object.entries(v.shapes).map(([g, x]) => [g, x.keys]));
	for (const g of sorted([...new Set([...Object.keys(want), ...Object.keys(d.shapes)])])) c.eq(`object group ${g}`, want[g], d.shapes[g]);
	c.eq('word properties', sorted(WORD_PROPS), sorted(Object.keys(v.words)));
	for (const prop of WORD_PROPS) {
		const hidden = v.unreachable.filter((u) => u[0] === prop).map((u) => u[1]);
		c.eq(`${prop} words`, sorted(Object.keys(v.words[prop]?.items ?? {})), sorted([...d.words[prop], ...hidden]));
		c.eq(`${prop} words declared unreachable that the samples reach`, [], hidden.filter((w) => d.words[prop].includes(w)));
	}
	const diagnostics = Object.fromEntries(Object.entries(v.diagnostics).map(([id, x]) => [id, x.keys]));
	for (const id of sorted([...new Set([...Object.keys(diagnostics), ...Object.keys(d.diagnostics)])])) c.eq(`diagnostic ${id} keys`, diagnostics[id], d.diagnostics[id]);
	c.eq('diagnostic kinds', DIAGNOSTIC_KINDS, sorted([...new Set(Object.keys(d.diagnostics).map((id) => id.split(' ')[0]))]));
	c.eq('expressions', v.expressions, d.expressions);
	c.eq('module ids', v.moduleIds, d.module_ids);
	c.eq('module id collisions', v.collisions, d.collisions);
	c.eq('module localities', v.localities, d.localities);
	c.eq('symbol resolutions', v.resolutions, d.resolutions);
	c.eq('sample batches are ok', [true, true, true, true, true, true], s.outputs.batchesOk);
	return c;
}

function rfcProblems(v, text = rfc) {
	const c = collector();
	const lines = text.split('\n');
	const blocks = text.split(/\n\s*\n/);
	const pairs = Object.entries(renderTables(v)).flatMap(([name, t]) => t.split(/\n\s*\n/).map((b) => [name, b]));
	const rendered = pairs.map((p) => p[1]);
	const inDoc = blocks.filter((b) => b.startsWith('|') || b.startsWith('#### '));
	c.eq('rendered blocks that are missing from the document', [], pairs.filter((p) => !inDoc.includes(p[1])).map((p) => `${p[0]}: ${head(p[1])}`));
	c.eq('table blocks of the document that no rendered table produces', [], inDoc.filter((b) => !rendered.includes(b)).map(head));
	c.eq('number of table blocks', rendered.length, inDoc.length);
	c.eq('lines that start with a table bar', rendered.join('\n').split('\n').filter((l) => l.startsWith('|')).length, lines.filter((l) => l.startsWith('|')).length);
	c.eq('title', TITLE, lines[0]);
	c.eq('level 2 headings', HEADINGS, lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3)));
	c.ok(`document has at most ${v.rfc.maxLines} lines`, lines.length <= v.rfc.maxLines);
	c.ok('document is not trivially short', blocks.length > 40);
	for (const [name, file] of [...v.exports.map((e) => [e[0], 'exports']), ...v.protocols.map((p) => [p[0], 'protocols']), ...v.defaults.map((x) => [x[0], 'defaults']), ...v.files.map((f) => [f[0], 'files'])]) c.ok(`${file} row ${name} is named in the document`, text.includes(name));
	for (const word of v.terms) c.ok(`term ${word} is written in a source, the helper or a fixture`, groundWords().has(word));
	textProblems(c, v, 'document', text);
	for (const [re, why] of SUPERSEDED) c.ok(`document does not say ${why}`, !re.test(text));
	return c;
}

function readmeProblems(v, text = readme) {
	const c = collector();
	const lines = text.split('\n');
	c.ok('README has at most 30 lines', lines.length <= 30);
	c.ok('README names INTERFACE_RFC.md', text.includes('INTERFACE_RFC.md'));
	c.ok('README names BASELINE.json', text.includes('BASELINE.json'));
	c.ok('README has no table row', !lines.some((l) => l.trim().startsWith('|')));
	c.eq('README paragraphs of 80 characters or more that the document repeats', [], text.split(/\n\s*\n/).filter((b) => b.length >= 80 && rfc.includes(b)).map(head));
	textProblems(c, v, 'README', text);
	return c;
}

function ownershipProblems(v) {
	const c = collector();
	const gate = (paths) => spawnSync(process.execPath, ['next/t00/check-ownership.mjs', 'paths', '--track', 'T06', ...paths], { cwd: ROOT, encoding: 'utf8' });
	const mine = v.ownership.filter((o) => o[2] === 'T06');
	const own = gate(mine.map((o) => o[1]));
	c.eq('gate exit code for the T06 paths', 0, own.status);
	c.ok('gate reports that the T06 paths belong to T06 only', own.stdout.startsWith(`OK ${mine.length} paths belong to T06 only`));
	const all = gate(v.ownership.map((o) => o[1]));
	c.eq('gate exit code when neighbour paths are included', 2, all.status);
	const failed = all.stdout.split('\n').filter((l) => l.startsWith('FAIL '));
	for (const [pattern, file, owner] of v.ownership) {
		c.ok(`${file} exists (only the plan scope has no files yet)`, fs.existsSync(path.join(ROOT, file)) || file.startsWith('next/t06/'));
		const prefix = { UNOWNED: `FAIL PATH_UNOWNED ${file} inside no track scope`, RESERVED: `FAIL PATH_RESERVED_HOT ${file} reserved for the coordinator` }[owner] ?? `FAIL PATH_OWNED_BY_OTHER_TRACK ${file} owned by ${owner}, not only by T06`;
		const lineOf = failed.filter((l) => l.split(' ')[2] === file);
		if (owner === 'T06') c.eq(`${pattern}: no failure line`, [], lineOf);
		else c.ok(`${pattern}: the gate reports ${owner}`, lineOf.length === 1 && lineOf[0].startsWith(prefix));
	}
	const entry = JSON.parse(read('next/t00/ownership-map.json')).tracks.find((t) => t.track === 'T06');
	c.eq('ownership map: plan scopes of T06', mine.map((o) => o[0]).filter((p) => p.startsWith('next/')), entry?.plan_scopes);
	c.eq('ownership map: suite scopes of T06', mine.map((o) => o[0]).filter((p) => !p.startsWith('next/')), entry?.suite_scopes);
	return c;
}

function consumerProblems(v) {
	const c = collector();
	const st = statics();
	for (const [file, kind, named] of v.consumers) {
		const found = fs.existsSync(path.join(ROOT, file));
		c.ok(`${file} exists`, found);
		if (!found) continue;
		const text = read(file);
		if (kind === 'import') c.eq(`${file}: layer files imported`, sorted(named), sorted(importsOf(text).specs.filter((x) => /language\/python\//.test(x)).map((x) => path.posix.basename(x))));
		else for (const n of named) c.ok(`${file} names ${n}`, text.includes(n));
		c.ok(`${file} is in the ownership table`, v.ownership.some((o) => o[1] === file));
	}
	for (const [file, names] of v.recognised) for (const n of names.split(', ')) c.ok(`${file} contains ${n}`, st.sources[file.replace(/\.mjs$/, '')]?.includes(n) === true);
	return c;
}

function registerProblems(v, checks = CHECKS) {
	const c = collector();
	const ids = v.claims.map((x) => x[0]);
	c.eq('claim ids are unique', ids.length, new Set(ids).size);
	c.eq('claims of the vocabulary vs checks of the test', sorted(ids), sorted(Object.keys(checks)));
	for (const [id, needs] of v.claims) {
		c.ok(`${id}: needs is one of ${NEEDS.join(', ')}`, NEEDS.includes(needs));
		c.eq(`${id}: needs agrees with the check`, needs, checks[id]?.needs);
	}
	c.eq('identity identifiers are unique', v.identity.length, new Set(v.identity.map((r) => r[0])).size);
	for (const row of v.identity) c.ok(`identity ${row[0]} is checked by a claim`, ids.includes(row[5]));
	c.eq('limit ids are unique', v.limits.length, new Set(v.limits.map((r) => r[0])).size);
	for (const [id, status, , by] of v.limits) {
		c.ok(`limit ${id}: ${status} is a limit status of the baseline library`, lib.LIMIT_STATUSES.includes(status));
		c.ok(`limit ${id} is checked by a claim or stated`, by === 'stated' || ids.includes(by));
	}
	const baseline = JSON.parse(read(`${DIR}/BASELINE.json`));
	c.ok('BASELINE.json carries an artifact_digest of 64 hex digits (the document names the field and does not repeat the value)', /^[0-9a-f]{64}$/.test(baseline.artifact_digest?.value ?? ''));
	c.eq('baseline limits (id, status) vs the vocabulary', baseline.limits.map((l) => [l.id, l.status]), v.baselineLimits.map((r) => r.slice(0, 2)));
	for (const [id, , by] of v.baselineLimits) c.ok(`baseline limit ${id}: its note is not repeated, a claim or a limit of this document`, by === 'not repeated' || ids.includes(by) || v.limits.some((l) => l[0] === by));
	const others = fs.readdirSync(path.join(ROOT, 'test/language-python')).filter((f) => f.endsWith('.mjs') && f !== 'interface-rfc.test.mjs').map((f) => [f, read(`test/language-python/${f}`)]);
	c.ok('other tests of the directory were read', others.length > 5);
	for (const [id, owner, state] of v.obligations) {
		const mentions = others.filter(([, text]) => text.includes(id)).map(([f]) => f);
		c.ok(`${id}: the owner is a track id`, /^T\d\d$/.test(owner));
		if (state === 'OPEN') c.eq(`${id} is open, so no other test of the directory names it`, [], mentions);
		else c.ok(`${id} is ${state}, so a test of the directory names it`, state === 'CLOSED' && mentions.length > 0);
	}
	return c;
}

// ---------------------------------------------------------------------------
// Claims: each claim id of the vocabulary has one check here that provokes the behaviour its statement describes. A check receives a
// collector and the vocabulary; its `needs` says what the host must offer: nothing, a POSIX shell, an approved interpreter, or
// only the source files (static).
// ---------------------------------------------------------------------------
const CHECKS = {};
const check = (id, needs, run) => { CHECKS[id] = { needs, run }; };
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return undefined; };
const one = (root, file, options = {}) => analyzer.analyzePythonFile({ repoRoot: root, file, ...options });
const many = (root, files, options = {}) => analyzer.analyzePythonFiles({ repoRoot: root, files, ...options });
const CALL = { analyzePythonFile: (o) => analyzer.analyzePythonFile({ file: 'a.py', ...o }), analyzePythonFiles: (o) => analyzer.analyzePythonFiles({ files: ['a.py'], ...o }) };
const broken = (dir, name, body = 'exit 1') => {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	fs.chmodSync(file, 0o755);
	return file;
};
// outside.py, proj/{real.py, dir/keep.py, link.py -> real.py, out.py -> ../outside.py} and projlink -> proj
function linkTree() {
	const base = fs.realpathSync(lib.tmpDir('t06-rfc-links-'));
	const proj = path.join(base, 'proj');
	fs.mkdirSync(path.join(proj, 'dir'), { recursive: true });
	fs.writeFileSync(path.join(base, 'outside.py'), 'o = 1\n');
	fs.writeFileSync(path.join(proj, 'real.py'), 'r = 1\n');
	fs.writeFileSync(path.join(proj, 'dir', 'keep.py'), 'k = 1\n');
	fs.symlinkSync('real.py', path.join(proj, 'link.py'));
	fs.symlinkSync('../outside.py', path.join(proj, 'out.py'));
	fs.symlinkSync('proj', path.join(base, 'projlink'));
	return { base, proj };
}
const EXTRA_BAD = { timeoutMs: [1.5, '5', Number.NaN, null, Infinity], maxBuffer: [70000.5], maxSourceBytes: ['2048'], maxFiles: [2.5] };

check('limits-are-validated-before-any-file-is-read', 'none', (c, v) => {
	const missing = path.join(fakeDir(), 'no-such-root');
	let rows = 0;
	for (const [option, appliesTo, , , message] of v.options) {
		const range = /between (\d+) and (\d+)/.exec(message);
		if (!range) continue;
		rows += 1;
		const [lo, hi] = [Number(range[1]), Number(range[2])];
		for (const fn of appliesTo.split(', ')) {
			for (const value of [lo - 1, hi + 1, ...(EXTRA_BAD[option] ?? [])]) c.throws(`${fn} ${option}=${String(value)}`, () => CALL[fn]({ repoRoot: missing, [option]: value }), message);
			for (const value of [lo, hi]) c.eq(`${fn} ${option}=${value} reaches the file system`, 'ENOENT', thrown(() => CALL[fn]({ repoRoot: missing, [option]: value }))?.code);
		}
	}
	c.eq('options with a stated range', ['maxBuffer', 'maxFiles', 'maxSourceBytes', 'timeoutMs'], sorted(v.options.filter((o) => /between \d+ and \d+/.test(o[4])).map((o) => o[0])));
	c.eq('rows with a stated range', 4, rows);
	c.eq('analyzePythonFile does not take maxFiles', 'ENOENT', thrown(() => CALL.analyzePythonFile({ repoRoot: missing, maxFiles: 0 }))?.code);
});

check('argument-errors-are-thrown-not-returned', 'posix', (c, v) => {
	const { proj } = linkTree();
	const outsideAbsolute = path.join(path.dirname(proj), 'outside.py');
	const cases = [
		['analyzePythonFile requires repoRoot and file', [() => analyzer.analyzePythonFile(), () => analyzer.analyzePythonFile({ repoRoot: proj }), () => analyzer.analyzePythonFile({ file: 'real.py' })]],
		['analyzePythonFiles requires repoRoot and files[]', [() => analyzer.analyzePythonFiles(), () => many(proj, 'real.py'), () => analyzer.analyzePythonFiles({ files: ['real.py'] })]],
		['Python file list exceeds configured 1-file analysis limit', [() => many(proj, ['real.py', 'dir/keep.py'], { maxFiles: 1, pythonCommand: NOWHERE })]],
		['analyzePythonFiles files[] must contain non-empty strings', [() => many(proj, ['']), () => many(proj, [5]), () => many(proj, ['real.py', ''])]],
		['Duplicate Python source after realpath resolution: real.py', [() => many(proj, ['real.py', 'link.py']), () => many(proj, ['link.py', 'real.py']), () => many(proj, ['real.py', './real.py'])]],
		['Python source escapes project root: ../outside.py', [() => one(proj, '../outside.py'), () => many(proj, ['../outside.py'])]],
		['Python source is not a regular file: dir', [() => one(proj, 'dir'), () => many(proj, ['dir'])]],
	];
	c.eq('messages of the errors table', sorted(v.errors.map((e) => e[1])), sorted(cases.map((x) => x[0])));
	for (const [message, calls] of cases) calls.forEach((fn, i) => c.throws(`${message} (call ${i + 1})`, fn, message));
	c.throws('a symlink to a file outside the root', () => one(proj, 'out.py'), 'Python source escapes project root: out.py');
	c.throws('the root itself', () => one(proj, '.'), 'Python source escapes project root: .');
	c.throws('an absolute path outside the root', () => one(proj, outsideAbsolute), `Python source escapes project root: ${outsideAbsolute}`);
	c.eq('one file with maxFiles 1 does not throw', 1, many(proj, ['real.py'], { maxFiles: 1, pythonCommand: NOWHERE }).results.length);
	for (const [what, fn] of [['a missing file', () => one(proj, 'missing.py')], ['a missing root', () => one(path.join(proj, 'no-such-dir'), 'real.py')], ['a missing file in a batch', () => many(proj, ['missing.py'])]]) {
		const error = thrown(fn);
		c.eq(`${what} throws the raw system error`, 'ENOENT', error?.code);
		c.ok(`${what}: the message starts with ENOENT`, String(error?.message).startsWith('ENOENT'));
	}
	// The EACCES case has its own test below (an unreadable source file): a process that can read a file of mode 000 cannot try it.
});

check('oversize-is-reported-before-interpreter-discovery', 'posix', (c) => {
	const dir = fakeDir();
	const standIn = makeRecorder(dir, 'record');
	const root = writeTree({ 'big.py': ' '.repeat(3000), 'edge.py': ' '.repeat(1024) });
	const r = one(root, 'big.py', { maxSourceBytes: 1024, pythonCommand: standIn });
	c.eq('ok', false, r.ok);
	c.eq('error', { code: 'PYTHON_SOURCE_TOO_LARGE', message: 'Python source exceeds configured 1024-byte analysis limit.' }, r.error);
	c.eq('source', { path: 'big.py', sizeBytes: 3000 }, r.source);
	c.eq('keys of the result', ['error', 'ok', 'protocol', 'source'], Object.keys(r).sort());
	c.eq('calls made to the stand-in interpreter for the oversize file', [], callsOf(dir));
	const edge = one(root, 'edge.py', { maxSourceBytes: 1024, pythonCommand: standIn });
	c.ok('a file of exactly the limit is not reported as oversize', edge.error?.code !== 'PYTHON_SOURCE_TOO_LARGE');
	c.ok('the same stand-in interpreter is probed for a file of exactly the limit', callsOf(dir).includes('probe'));
});

check('no-interpreter-keeps-the-source-reference', 'none', (c) => {
	const body = 'x = 1\n';
	const root = writeTree({ 'a.py': body });
	const r = one(root, 'a.py', { pythonCommand: NOWHERE });
	c.eq('ok', false, r.ok);
	c.eq('error', { code: 'PYTHON_RUNTIME_UNAVAILABLE', message: 'No approved Python interpreter was found for the optional static AST helper.' }, r.error);
	c.eq('source', { path: 'a.py', sha256: sha(body), sizeBytes: Buffer.byteLength(body) }, r.source);
	c.eq('keys of the result', ['error', 'ok', 'protocol', 'source'], Object.keys(r).sort());
});

check('empty-and-oversize-batches-need-no-interpreter', 'posix', (c) => {
	const dir = fakeDir();
	const standIn = makeRecorder(dir, 'record');
	const root = writeTree({ 'big.py': ' '.repeat(3000), 'small.py': 'x = 1\n' });
	const empty = many(root, [], { pythonCommand: standIn });
	c.eq('empty batch', { protocol: 'bskel.python-ast.batch-response/1', ok: true, runtime: null, results: [] }, empty);
	const emptyDefault = many(root, []);
	c.eq('empty batch without an explicit command', { ok: true, runtime: null }, { ok: emptyDefault.ok, runtime: emptyDefault.runtime });
	const big = many(root, ['big.py'], { maxSourceBytes: 1024, pythonCommand: standIn });
	c.eq('oversize-only batch', { ok: false, runtime: null, codes: ['PYTHON_SOURCE_TOO_LARGE'] }, { ok: big.ok, runtime: big.runtime, codes: big.results.map((r) => r.error?.code) });
	c.eq('calls made to the stand-in interpreter for the empty batch and the oversize-only batch', [], callsOf(dir));
	const mixed = many(root, ['small.py', 'big.py'], { maxSourceBytes: 1024, pythonCommand: NOWHERE });
	c.eq('mixed batch without an interpreter', { ok: false, runtime: null, codes: ['PYTHON_SOURCE_TOO_LARGE', 'PYTHON_RUNTIME_UNAVAILABLE'] }, { ok: mixed.ok, runtime: mixed.runtime, codes: mixed.results.map((r) => r.error?.code) });
	const seen = many(root, ['small.py', 'big.py'], { maxSourceBytes: 1024, pythonCommand: standIn });
	c.eq('mixed batch with the stand-in: the interpreter handle', { executable: standIn, version: '3.12.0' }, seen.runtime);
	c.ok('mixed batch with the stand-in: the interpreter is probed because one file is left', callsOf(dir).includes('probe'));
	c.eq('mixed batch with the stand-in: the oversize file is still reported', 'PYTHON_SOURCE_TOO_LARGE', seen.results.find((r) => r.source?.path === 'big.py')?.error?.code);
});

check('explicit-command-has-no-fallback', 'posix', (c) => {
	const dir = fakeDir();
	const usable = makeFake(dir, 'python3', 'exit 0');
	const old = makeFake(dir, 'old', 'exit 0', '3.7.9');
	const down = broken(dir, 'down');
	withEnv({ PATH: `${dir}:${process.env.PATH}`, BSKEL_PYTHON: undefined }, () => {
		c.eq('no explicit command finds python3 on PATH', { executable: usable, version: '3.12.0' }, analyzer.findPythonRuntime());
		c.eq('explicit command that does not exist', null, analyzer.findPythonRuntime({ pythonCommand: NOWHERE }));
		c.eq('explicit command that exits non-zero', null, analyzer.findPythonRuntime({ pythonCommand: down }));
		c.eq('explicit command below version 3.8', null, analyzer.findPythonRuntime({ pythonCommand: old }));
		c.eq('explicit bare name that is not on PATH', null, analyzer.findPythonRuntime({ pythonCommand: 'no-such-python-name' }));
		c.eq('explicit usable command', { executable: usable, version: '3.12.0' }, analyzer.findPythonRuntime({ pythonCommand: usable }));
		c.eq('explicit bare name found on PATH', { executable: usable, version: '3.12.0' }, analyzer.findPythonRuntime({ pythonCommand: 'python3' }));
	});
});

check('batch-results-are-sorted-by-source-path', 'none', (c) => {
	const names = ['a.py', 'B.py', 'c.py', 'D.py', 'a/b.py', '_x.py', 'z10.py', 'z9.py'];
	const root = writeTree(Object.fromEntries(names.map((n) => [n, ' '.repeat(3000)])));
	const expected = [...names].sort((x, y) => x.localeCompare(y));
	for (const [what, order] of [['input order as written', names], ['input order reversed', [...names].reverse()]]) {
		const batch = many(root, order, { maxSourceBytes: 1024, pythonCommand: NOWHERE });
		c.eq(`${what}: result paths`, expected, batch.results.map((r) => r.source.path));
	}
	if ('a.py'.localeCompare('B.py') < 0) c.ok('the order differs from code-unit order on this host', expected.join() !== [...names].sort().join());
});

check('source-path-is-the-realpath-relative-to-the-root', 'posix', (c) => {
	const { base, proj } = linkTree();
	const path8 = (root, file) => one(root, file, { pythonCommand: NOWHERE }).source.path;
	c.eq('a symlink inside the root', 'real.py', path8(proj, 'link.py'));
	c.eq('an absolute path inside the root', 'real.py', path8(proj, path.join(proj, 'real.py')));
	c.eq('a path with dot segments', 'real.py', path8(proj, './dir/../real.py'));
	c.eq('a root reached through a symlink', 'real.py', path8(path.join(base, 'projlink'), 'real.py'));
	c.eq('a nested file', 'dir/keep.py', path8(proj, 'dir/keep.py'));
	c.throws('a symlink to a file outside the root', () => one(proj, 'out.py', { pythonCommand: NOWHERE }), 'Python source escapes project root: out.py');
	c.eq('a batch reports the same path once', ['real.py'], many(proj, ['link.py'], { pythonCommand: NOWHERE }).results.map((r) => r.source.path));
});

const ENVELOPE = '{"protocol":"bskel.python-ast.response/1","ok":true,"facts":{}}';
const FLOOD = 'i=0; while [ $i -lt 9000 ]; do echo 123456789; i=$((i+1)); done';
const SOURCE_A = 'x = 1\n';

check('interpreter-discovery-rules', 'posix', (c) => {
	const dir = fakeDir();
	const second = fakeDir();
	const probeVersion = (probe) => analyzer.findPythonRuntime({ pythonCommand: makeFake(fakeDir(), 'py', 'exit 0', probe) })?.version ?? null;
	for (const [probe, want] of [['3.7.9', null], ['3.8.0', '3.8.0'], ['3.12.4', '3.12.4'], ['4.0.0', '4.0.0'], ['3.12', null], ['3.12.0.1', null], ['abc', null], ['Python 3.12.0', null], ['', null]]) c.eq(`probe output "${probe}"`, want, probeVersion(probe));
	const pyThree = makeFake(dir, 'python3', 'exit 0', '3.12.0');
	const pyPlain = makeFake(dir, 'python', 'exit 0', '3.11.0');
	const pyHere = makeFake(second, 'python3', 'exit 0', '3.10.0');
	const first = makeFake(fakeDir(), 'first', 'exit 0', '3.9.1');
	const down = broken(fakeDir(), 'down');
	withEnv({ PATH: dir, BSKEL_PYTHON: undefined }, () => c.eq('python3 is tried before python', { executable: pyThree, version: '3.12.0' }, analyzer.findPythonRuntime()));
	withEnv({ PATH: dir, BSKEL_PYTHON: first }, () => c.eq('BSKEL_PYTHON is tried first', { executable: first, version: '3.9.1' }, analyzer.findPythonRuntime()));
	withEnv({ PATH: dir, BSKEL_PYTHON: down }, () => c.eq('an unusable BSKEL_PYTHON falls back to python3', pyThree, analyzer.findPythonRuntime()?.executable));
	withEnv({ PATH: dir, BSKEL_PYTHON: NOWHERE }, () => c.eq('a missing BSKEL_PYTHON falls back to python3', pyThree, analyzer.findPythonRuntime()?.executable));
	withEnv({ PATH: dir, BSKEL_PYTHON: first }, () => c.eq('an explicit command wins over BSKEL_PYTHON', pyPlain, analyzer.findPythonRuntime({ pythonCommand: pyPlain })?.executable));
	const refused = makeFake(fakeDir(), 'python3', 'exit 0', '3.7.9');
	const plain = makeFake(path.dirname(refused), 'python', 'exit 0', '3.11.0');
	withEnv({ PATH: path.dirname(refused), BSKEL_PYTHON: undefined }, () => c.eq('python is tried after a refused python3', plain, analyzer.findPythonRuntime()?.executable));
	withEnv({ PATH: `${dir}:${second}`, BSKEL_PYTHON: undefined }, () => {
		c.eq('denyRoots skips an interpreter below a denied root', pyHere, analyzer.findPythonRuntime({ denyRoots: [dir] })?.executable);
		c.eq('a denied root that does not exist is ignored', pyThree, analyzer.findPythonRuntime({ denyRoots: [path.join(dir, 'no-such-dir')] })?.executable);
	});
	withEnv({ PATH: dir, BSKEL_PYTHON: undefined }, () => c.eq('denyRoots can leave no interpreter', null, analyzer.findPythonRuntime({ denyRoots: [dir] })));
	fs.mkdirSync(path.join(dir, 'bin'));
	makeFake(path.join(dir, 'bin'), 'python3', 'exit 0');
	const cwd = process.cwd();
	try {
		process.chdir(dir);
		withEnv({ PATH: '.', BSKEL_PYTHON: undefined }, () => c.eq('a relative PATH entry is ignored', null, analyzer.findPythonRuntime()));
		withEnv({ PATH: 'bin', BSKEL_PYTHON: undefined }, () => c.eq('a relative PATH directory is ignored', null, analyzer.findPythonRuntime()));
		withEnv({ PATH: dir, BSKEL_PYTHON: undefined }, () => {
			c.eq('the same file through an absolute entry is found', pyThree, analyzer.findPythonRuntime()?.executable);
			for (const command of ['bin/python3', './python3', 'py thon', 'python3;ls']) c.eq(`explicit command "${command}"`, null, analyzer.findPythonRuntime({ pythonCommand: command }));
		});
	} finally {
		process.chdir(cwd);
	}
	const root = writeTree({ 'a.py': SOURCE_A });
	const inside = makeFake(root, 'fakepy', 'exit 0');
	const outside = makeFake(fakeDir(), 'fakepy', 'exit 0');
	c.eq('an interpreter inside the project root is refused', 'PYTHON_RUNTIME_UNAVAILABLE', one(root, 'a.py', { pythonCommand: inside }).error?.code);
	c.eq('the same refusal in a batch', { runtime: null, codes: ['PYTHON_RUNTIME_UNAVAILABLE'] }, ((b) => ({ runtime: b.runtime, codes: b.results.map((r) => r.error?.code) }))(many(root, ['a.py'], { pythonCommand: inside })));
	const used = one(root, 'a.py', { pythonCommand: outside });
	c.eq('an interpreter outside the project root is run', 'PYTHON_ANALYZER_PROTOCOL_ERROR', used.error?.code);
	c.ok('its empty output is reported as invalid JSON', String(used.error?.message).startsWith('Python helper returned invalid JSON: '));
});

check('helper-failures-are-results-not-throws', 'posix', (c) => {
	const dir = fakeDir();
	const root = writeTree({ 'a.py': SOURCE_A });
	const source = { path: 'a.py', sha256: sha(SOURCE_A), sizeBytes: Buffer.byteLength(SOURCE_A) };
	const run = (name, body, options = {}) => one(root, 'a.py', { pythonCommand: makeFake(dir, name, body), ...options });
	const envelope = 'Python helper returned an unexpected protocol envelope.';
	const cases = [
		['output that is not JSON', run('bad-json', 'echo not-json'), 'PYTHON_ANALYZER_PROTOCOL_ERROR', (m) => m.startsWith('Python helper returned invalid JSON: ')],
		['empty output', run('empty', 'exit 0'), 'PYTHON_ANALYZER_PROTOCOL_ERROR', (m) => m.startsWith('Python helper returned invalid JSON: ')],
		['a wrong protocol string', run('envelope', 'echo \'{"protocol":"x","ok":true}\''), 'PYTHON_ANALYZER_PROTOCOL_ERROR', (m) => m === envelope],
		['an ok flag that is not a boolean', run('okstr', 'echo \'{"protocol":"bskel.python-ast.response/1","ok":"yes"}\''), 'PYTHON_ANALYZER_PROTOCOL_ERROR', (m) => m === envelope],
		['a non-zero exit', run('exit3', 'echo boom >&2; exit 3'), 'PYTHON_ANALYZER_FAILED', (m) => m === 'Python helper exited 3: boom\n'],
		['a timeout', run('slow', 'exec /bin/sleep 5', { timeoutMs: 150 }), 'PYTHON_ANALYZER_TIMEOUT', (m) => m.includes('ETIMEDOUT')],
		['an output flood', run('flood', FLOOD, { maxBuffer: 65536 }), 'PYTHON_ANALYZER_FAILED', (m) => m.includes('ENOBUFS')],
	];
	for (const [what, r, code, message] of cases) {
		c.eq(`${what}: ok`, false, r.ok);
		c.eq(`${what}: code`, code, r.error?.code);
		c.ok(`${what}: message ${JSON.stringify(r.error?.message)}`, message(String(r.error?.message)));
		c.eq(`${what}: source reference`, source, r.source);
		c.ok(`${what}: no facts`, !('facts' in r));
	}
	const good = run('envelope-ok', `echo '${ENVELOPE}'`);
	c.eq('a well-formed envelope is passed through', { ok: true, facts: {}, source }, { ok: good.ok, facts: good.facts, source: good.source });
});

check('stderr-is-cut-at-800-characters', 'posix', (c) => {
	const dir = fakeDir();
	const root = writeTree({ 'a.py': SOURCE_A });
	for (const n of [900, 801, 800, 799, 1]) {
		const r = one(root, 'a.py', { pythonCommand: makeFake(dir, `err${n}`, `printf '%s' ${'y'.repeat(n)} >&2; exit 3`) });
		c.eq(`${n} characters on stderr`, `Python helper exited 3: ${'y'.repeat(Math.min(n, 800))}`, r.error?.message);
	}
});

check('helper-is-started-isolated', 'posix', (c) => {
	// The stand-in sits in a directory whose name holds a space and shell metacharacters. Its script does not contain that path: it finds its directory when it runs, from its own location, and writes its records there.
	const dir = path.join(fakeDir(), 'rec dir; $(echo x) \'q\' "dq" & *');
	fs.mkdirSync(dir);
	const root = writeTree({ 'a.py': SOURCE_A });
	const body = ['d="${0%/*}"', 'for a in "$@"; do printf \'%s\\n\' "$a"; done > "$d/args.txt"', '/bin/cat > "$d/stdin.txt"', '/usr/bin/env > "$d/env.txt"'].join('\n');
	const fake = makeFake(dir, 'record', body, '3.12.0', false);
	withEnv({ T06_RFC_SENTINEL: 'present' }, () => one(root, 'a.py', { pythonCommand: fake }));
	const args = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').split('\n').filter(Boolean);
	c.eq('arguments', ['-I', '-S', '-B', '-X', 'utf8'], args.slice(0, 5));
	c.eq('the last argument is the helper file', fs.realpathSync(path.join(ROOT, DIR, 'ast-helper.py')), args.length === 6 ? fs.realpathSync(args[5]) : undefined);
	const request = JSON.parse(fs.readFileSync(path.join(dir, 'stdin.txt'), 'utf8'));
	c.eq('request keys', ['filename', 'protocol', 'source_base64'], Object.keys(request).sort());
	c.eq('request protocol', analyzer.PYTHON_AST_REQUEST_PROTOCOL, request.protocol);
	c.eq('request filename', 'a.py', request.filename);
	c.eq('request source', SOURCE_A, Buffer.from(request.source_base64, 'base64').toString('utf8'));
	const names = fs.readFileSync(path.join(dir, 'env.txt'), 'utf8').split('\n').map((l) => l.split('=')[0]);
	c.ok('the recording script ran', names.length > 0 || fs.existsSync(path.join(dir, 'env.txt')));
	for (const name of ['T06_RFC_SENTINEL', 'HOME', 'USER', 'TMPDIR', 'LANG', 'SHELL', 'LOGNAME', 'BSKEL_PYTHON']) c.ok(`the environment of the helper has no ${name}`, !names.includes(name));
});

check('helper-source-has-no-execution-primitives', 'static', (c) => {
	const st = statics();
	const statements = [...st.helper.matchAll(/^[ \t]*((?:import|from)\s[^\n]*)$/gm)].map((m) => m[1]);
	c.eq('import statements of the helper', ['import ast', 'import base64', 'import io', 'import json', 'import math', 'import sys', 'import tokenize'], statements);
	c.eq('modules imported by the helper', ['ast', 'base64', 'io', 'json', 'math', 'sys', 'tokenize'], st.helperImports);
	c.eq('calls of exec, eval, compile, open or __import__', [], [...st.helper.matchAll(/\b(?:exec|eval|compile|open|__import__)\s*\(/g)].map((m) => m[0]));
	c.eq('uses of os, subprocess, importlib or socket', [], [...st.helper.matchAll(/\b(?:os|subprocess|importlib|socket)\b/g)].map((m) => m[0]));
	const users = (spec) => Object.entries(st.loads).filter(([, l]) => l.specs.includes(spec)).map(([stem]) => stem);
	c.eq('modules that import node:child_process', ['analyzer'], users('node:child_process'));
	c.eq('modules that import node:fs', ['analyzer'], users('node:fs'));
	c.eq('members of the file system module that analyzer.mjs uses', ['readFileSync', 'realpathSync', 'statSync'], sorted([...new Set([...st.sources.analyzer.matchAll(/\bfs\.(\w+)/g)].map((x) => x[1]))]));
	c.eq('modules that were inspected', sorted(Object.keys(MODS)), sorted(Object.keys(st.loads)));
});

check('helper-and-analyzer-agree-on-protocols', 'static', (c, v) => {
	const st = statics();
	c.eq('request constant', analyzer.PYTHON_AST_REQUEST_PROTOCOL, st.helperProtocols.request);
	c.eq('response constant', analyzer.PYTHON_AST_RESPONSE_PROTOCOL, st.helperProtocols.response);
	for (const [name, value] of v.protocols) c.ok(`${name} ends with /1`, /\/1$/.test(value) && analyzer[name] === value);
	c.eq('number of protocol strings', 3, v.protocols.length);
});

check('stable-scanners-do-not-import-the-layer', 'static', (c) => {
	const found = [];
	let scanned = 0;
	const walk = (rel) => {
		for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
			const child = `${rel}/${e.name}`;
			if (e.isDirectory()) { if (e.name !== 'node_modules' && child !== DIR) walk(child); continue; }
			if (!e.isFile() || !/\.(?:mjs|js|cjs|ts)$/.test(e.name)) continue;
			scanned += 1;
			if (read(child).includes('language/python')) found.push(child);
		}
	};
	walk('scanners');
	c.ok('files were scanned', scanned > 20);
	c.eq('files outside the layer that name the layer', [], found);
});

const factsOf = (source, options = {}) => {
	const root = writeTree({ 'a.py': source });
	return one(root, 'a.py', options);
};
const valueOf = (result, name) => result.facts.assignments.find((a) => a.targets.length === 1 && a.targets[0] === name)?.value;
const innermost = (value) => {
	let depth = 0;
	let node = value;
	while (node?.kind === 'sequence') { depth += 1; node = node.items[0]; }
	return { depth, leaf: node };
};
const idOf = (p) => p.replace(/\.[^./]*$/, '').split('/').join('.').replace(/(^|\.)__init__$/, '');
const dirIdOf = (p) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p).split('/').join('.'));

check('numeric-and-depth-rules', 'python', (c) => {
	const r = factsOf(lines(
		'A = 9007199254740991', 'B = -9007199254740991', 'C = 9007199254740992', 'D = -9007199254740992', 'E = 1e999', 'F = -1e999',
		`G = ${nest(12)}`, `H = ${nest(13)}`, `I = ${nest(14)}`, 'J = 1 + 2', 'K = int | str', 'L = int & str',
	));
	c.eq('result is ok', true, r.ok);
	c.eq('largest safe integer', { kind: 'constant', value: 9007199254740991 }, valueOf(r, 'A'));
	c.eq('smallest safe integer', { kind: 'constant', value: -9007199254740991 }, valueOf(r, 'B'));
	c.eq('first integer beyond the safe range', { decimal: '9007199254740992', kind: 'integer', reason: 'outside-js-safe-integer' }, valueOf(r, 'C'));
	c.eq('first negative integer beyond the safe range', { decimal: '-9007199254740992', kind: 'integer', reason: 'outside-js-safe-integer' }, valueOf(r, 'D'));
	c.eq('positive infinity', { kind: 'float-special', reason: 'non-finite-json-number', value: 'Infinity' }, valueOf(r, 'E'));
	c.eq('negative infinity', { kind: 'float-special', reason: 'non-finite-json-number', value: '-Infinity' }, valueOf(r, 'F'));
	c.eq('12 brackets are read in full', { depth: 12, leaf: { kind: 'constant', value: 1 } }, innermost(valueOf(r, 'G')));
	c.eq('13 brackets: the constant on the 14th level is unknown', { depth: 13, leaf: { kind: 'unknown', node: 'Constant', reason: 'depth-limit' } }, innermost(valueOf(r, 'H')));
	c.eq('14 brackets: the list on the 14th level is unknown', { depth: 13, leaf: { kind: 'unknown', node: 'List', reason: 'depth-limit' } }, innermost(valueOf(r, 'I')));
	c.eq('an operator other than BitOr', { kind: 'unknown', node: 'BinOp' }, valueOf(r, 'J'));
	c.eq('BitAnd is also unknown', { kind: 'unknown', node: 'BinOp' }, valueOf(r, 'L'));
	c.eq('BitOr', { kind: 'binary', left: { kind: 'symbol', name: 'int' }, operator: 'BitOr', right: { kind: 'symbol', name: 'str' } }, valueOf(r, 'K'));
});

check('nested-statements-are-dropped', 'python', (c) => {
	const r = factsOf(lines(
		'import top_import', 'if cond:', '    import hidden', '    def cond_fn(): pass', '    class CondCls: pass', '    cond_assign = 1', '    cond_call(2)', '    cond_aug += 1',
		'try:', '    import maybe', 'except ImportError:', '    maybe = None',
		'def outer():', '    def nested_fn(): pass', '    class Inner: pass', '    local = 1',
		'class K:', '    class InnerK: pass', '    if True:', '        hidden_field = 1', '    kept_field = 1', '    def meth(self): pass',
	));
	const f = r.facts;
	c.eq('imports', ['top_import'], f.imports.map((i) => i.names?.[0]?.name ?? i.module));
	c.eq('functions', ['outer'], f.functions.map((x) => x.name));
	c.eq('classes', ['K'], f.classes.map((x) => x.name));
	c.eq('fields of K', ['kept_field'], f.classes[0].fields.map((x) => x.targets[0]));
	c.eq('methods of K', ['meth'], f.classes[0].methods.map((x) => x.name));
	c.eq('top-level assignments', [], f.assignments.map((x) => x.targets[0]));
	c.eq('control-flow mutations (kind, line)', [['assignment', 6], ['call', 7], ['augmented-assignment', 8], ['assignment', 12]], f.controlFlowMutations.map((m) => [m.kind, m.line]));
});

check('syntax-errors-carry-a-position', 'python', (c) => {
	const r = factsOf('x = 1\ndef (:\n');
	c.eq('ok', false, r.ok);
	c.eq('error code', 'PYTHON_SYNTAX_ERROR', r.error?.code);
	c.eq('error keys', ['code', 'column', 'end_column', 'end_line', 'line', 'message'], Object.keys(r.error ?? {}).sort());
	c.eq('line of the error', 2, r.error?.line);
	c.ok('column is a positive integer', Number.isInteger(r.error?.column) && r.error.column > 0);
	const [major = 0, minor = 0] = factsOf('x = 1\n').runtime?.version ?? [];
	const modern = major > 3 || (major === 3 && minor >= 10);
	for (const key of ['end_line', 'end_column']) c.ok(`${key} is a positive integer when the interpreter is 3.10 or newer and null before`, modern ? Number.isInteger(r.error?.[key]) && r.error[key] > 0 : r.error?.[key] === null);
	c.ok('message is text', typeof r.error?.message === 'string' && r.error.message.length > 0);
	c.ok('no facts', !('facts' in r));
	const root = writeTree({ 'cookie.py': '# coding: nonexistent-enc\nx = 1\n', 'latin.py': '# -*- coding: latin-1 -*-\nx = 1\n', 'bad.py': Buffer.from([0x78, 0x3d, 0x22, 0xff, 0x22, 0x0a]) });
	c.eq('unknown encoding', 'PYTHON_SOURCE_ENCODING_UNSUPPORTED', one(root, 'cookie.py').error?.code);
	c.eq('bytes that are not valid UTF-8', 'PYTHON_SOURCE_ENCODING_UNSUPPORTED', one(root, 'bad.py').error?.code);
	const latin = one(root, 'latin.py');
	c.eq('a declared encoding is read and reported', { ok: true, encoding: 'iso-8859-1' }, { ok: latin.ok, encoding: latin.source?.encoding });
});

check('deeply-nested-parentheses-fail-the-file', 'python', (c) => {
	const r = factsOf(`x = ${'('.repeat(300)}1${')'.repeat(300)}\n`);
	c.eq('ok', false, r.ok);
	c.ok('the code is a syntax error or a helper failure', ['PYTHON_SYNTAX_ERROR', 'PYTHON_ANALYZER_FAILED'].includes(r.error?.code));
	c.ok('no facts', !('facts' in r));
	const fine = factsOf(`x = ${'('.repeat(20)}1${')'.repeat(20)}\n`);
	c.eq('20 nested parentheses are read', true, fine.ok);
});

check('deep-attribute-chains-fail-the-helper', 'python', (c) => {
	const r = factsOf(`x = a${'.b'.repeat(20000)}\n`, { timeoutMs: 20000 });
	c.eq('ok', false, r.ok);
	c.eq('code', 'PYTHON_ANALYZER_FAILED', r.error?.code);
	c.ok('message starts with the exit status', /^Python helper exited 1: /.test(String(r.error?.message)));
	c.ok('no facts', !('facts' in r));
});

check('module-ids-come-from-paths', 'python', (c, v) => {
	const rows = v.moduleIds;
	c.ok('there are rows', rows.length >= 6);
	for (const [p, id, pkg, isPackage] of rows) {
		c.eq(`module id of ${p}`, idOf(p), id);
		c.eq(`package id of ${p}`, dirIdOf(p), pkg);
		c.eq(`package flag of ${p}`, /(^|\/)__init__\.pyi?$/.test(p), isPackage);
	}
	c.ok('hyphens are kept', rows.some((r) => r[1] === 'my-dir.x'));
	c.ok('a source root is part of the id', rows.some((r) => r[1] === 'src.app.main'));
	c.ok('a dot in a file name is kept', rows.some((r) => r[1] === 'p.q'));
	const s = samples();
	c.eq('listed paths of the sample project', sorted(rows.map((r) => r[0])), sorted(s.projects.ids.list().map((m) => m.source.path)));
	const root = writeTree({ 'p.q.py': 'a = 1\n', 'p/q.py': 'b = 1\n', 'p/__init__.py': '' });
	const clash = resolver.buildPythonProjectFacts(analyzer.analyzePythonFiles({ repoRoot: root, files: ['p.q.py', 'p/q.py', 'p/__init__.py'] }).results);
	c.eq('p.q.py and p/q.py share an id', [{ moduleId: 'p.q', sources: ['p.q.py', 'p/q.py'] }], clash.collisions);
});

check('colliding-modules-are-excluded', 'python', (c, v) => {
	const p = samples().projects.ids;
	c.eq('collisions', [{ moduleId: 'a.b', sources: ['a/b.py', 'a/b/__init__.py'] }, { moduleId: 'stub', sources: ['stub.py', 'stub.pyi'] }], p.collisions);
	const listed = p.list().map((m) => m.moduleId);
	for (const id of ['a.b', 'stub']) {
		c.ok(`${id} has no module entry`, !listed.includes(id));
		c.eq(`${id} locality`, 'ambiguous', p.moduleLocality(id));
	}
	c.eq('a module that no source produces', 'external', p.moduleLocality('nothere'));
	c.eq('a module without a collision', 'local', p.moduleLocality('top'));
	c.eq('the vocabulary names the same collisions', v.collisions.map((r) => r[0]), p.collisions.map((x) => x.moduleId));
});

check('failed-files-vanish-and-read-as-external', 'python', (c) => {
	const { project, batch } = analyzeProject({ 'good.py': 'x = 1\n', 'bad.py': 'def (:\n', 'user.py': 'from bad import thing\nfrom good import x\n' });
	c.eq('the batch is not ok', false, batch.ok);
	c.eq('modules of the project', ['good', 'user'], project.list().map((m) => m.moduleId).sort());
	c.eq('locality of the failed module', 'external', project.moduleLocality('bad'));
	const r = resolver.resolvePythonSymbol(project, 'user', 'thing');
	c.eq('a name imported from the failed module', { status: 'resolved', locality: 'external' }, { status: r.status, locality: r.locality });
	c.eq('the same name from a module that analyzed', 'resolved', resolver.resolvePythonSymbol(project, 'user', 'x').status);
	const loose = resolver.buildPythonProjectFacts([{ ok: false, source: { path: 'x.py' } }, null, { ok: true, source: { path: 'y.py' }, facts: { imports: [], classes: [], functions: [], assignments: [] } }]);
	c.eq('entries that are not ok are skipped', ['y'], loose.list().map((m) => m.moduleId));
});

check('resolved-names-are-not-checked', 'python', (c) => {
	const s = samples();
	const mod = s.projects.resolver.list().find((m) => m.moduleId === 'pkg.thing');
	const declared = [...mod.facts.classes, ...mod.facts.functions].map((x) => x.name);
	c.eq('names declared by the module', ['Inner'], declared);
	const real = resolver.resolvePythonSymbol(s.projects.resolver, 'pkg.other', 'thing.Inner');
	const fake = resolver.resolvePythonSymbol(s.projects.resolver, 'pkg.other', 'thing.NoSuchName');
	c.eq('a declared name', { status: 'resolved', locality: 'local', module: 'pkg.thing', name: 'Inner' }, real);
	c.eq('a name that the module does not declare', { status: 'resolved', locality: 'local', module: 'pkg.thing', name: 'NoSuchName' }, fake);
});

const lineOf = (text, exact) => text.split('\n').indexOf(exact) + 1;
const keysDeep = (value, into = new Map()) => {
	if (Array.isArray(value)) { for (const x of value) keysDeep(x, into); return into; }
	if (!value || typeof value !== 'object' || value instanceof Map) return into;
	for (const [k, x] of Object.entries(value)) { into.set(k, (into.get(k) ?? 0) + 1); keysDeep(x, into); }
	return into;
};

check('duplicate-names-last-definition-wins', 'python', (c) => {
	const { project } = analyzeProject({
		'models.py': lines('from pydantic import BaseModel', 'class Dup(BaseModel):', '    first: int', 'class Dup(BaseModel):', '    second: int'),
		'a.py': 'x = 1\n', 'b.py': 'y = 1\n', 'c.py': lines('from a import x as v', 'from b import y as v'),
		'assign_after.py': lines('from pydantic import BaseModel as x', 'x = 42'),
		'assign_before.py': lines('x = 42', 'from pydantic import BaseModel as x'),
		'def_after.py': lines('from pydantic import BaseModel as x', 'def x(): pass'),
		'def_before.py': lines('def x(): pass', 'from pydantic import BaseModel as x'),
		'class_after.py': lines('from pydantic import BaseModel as x', 'class x: pass'),
		'class_before.py': lines('class x: pass', 'from pydantic import BaseModel as x'),
	});
	const models = modelShape.projectPythonModels(project);
	c.eq('one model for two classes of one name', ['models#Dup'], models.map((m) => m.ref));
	c.eq('its fields are those of the later class', ['second'], models[0]?.fields.map((f) => f.name));
	c.eq('the alias resolves to the later import', { status: 'resolved', locality: 'local', module: 'b', name: 'y' }, resolver.resolvePythonSymbol(project, 'c', 'v'));
	// A name that is both an import alias and an assignment, a function or a class stays the import, in either order (not modeled: a later binding does not replace it).
	const kept = { status: 'resolved', locality: 'external', module: 'pydantic', name: 'BaseModel' };
	for (const mod of ['assign_after', 'assign_before', 'def_after', 'def_before', 'class_after', 'class_before']) c.eq(`${mod}: x stays the import`, kept, resolver.resolvePythonSymbol(project, mod, 'x'));
});

check('unresolved-model-bases-are-omitted', 'python', (c) => {
	const s = samples();
	const base = s.projects.models.list().find((m) => m.moduleId === 'm.base');
	const declared = base.facts.classes.map((x) => x.name);
	const refs = s.outputs.models.map((m) => m.ref);
	for (const name of ['Plain', 'Unres', 'CycA', 'CycB']) {
		c.ok(`m.base declares ${name}`, declared.includes(name));
		c.ok(`m.base#${name} is not a model`, !refs.includes(`m.base#${name}`));
	}
	for (const name of ['Base', 'Settings', 'Ent', 'Dto']) c.ok(`m.base#${name} is a model`, refs.includes(`m.base#${name}`));
	c.ok('no model has an unknown family', s.outputs.models.every((m) => m.family !== 'unknown'));
	// Several bases: a base that does not resolve is ignored and the other bases decide. The fixture has no module named other, so Thing is an external base without a family.
	const multi = analyzeProject({
		'multi.py': lines(
			'from pydantic import BaseModel',
			'from other import Thing',
			'class Direct(BaseModel): pass',
			'class Mixed(Missing, BaseModel): pass',
			'class MixedAfter(BaseModel, Missing): pass',
			'class Third(Thing, BaseModel): pass',
			'class ThirdAfter(BaseModel, Thing): pass',
			'class Only(Missing): pass',
			'class Fourth(Thing): pass',
		),
	});
	const shaped = modelShape.projectPythonModels(multi.project);
	const byRef = Object.fromEntries(shaped.map((m) => [m.ref, m]));
	c.eq('the classes with a recognized base are models', sorted(['multi#Direct', 'multi#Mixed', 'multi#MixedAfter', 'multi#Third', 'multi#ThirdAfter']), sorted(shaped.map((m) => m.ref)));
	c.eq('all of them are pydantic models', ['pydantic'], [...new Set(shaped.map((m) => m.family))]);
	c.eq('an unresolved base before the recognized one is not listed', byRef['multi#Direct']?.bases, byRef['multi#Mixed']?.bases);
	c.eq('an unresolved base after the recognized one is not listed', byRef['multi#Direct']?.bases, byRef['multi#MixedAfter']?.bases);
	for (const name of ['Only', 'Fourth']) c.ok(`multi#${name} is not a model`, !shaped.some((m) => m.className === name));
	c.ok('nothing in the model list mentions the left-out classes', !/"(?:Only|Fourth)"|multi#(?:Only|Fourth)/.test(JSON.stringify(shaped)));
});

check('framework-names-are-matched-after-resolution', 'python', (c) => {
	const { project } = analyzeProject({
		'app/__init__.py': '',
		'app/aliased.py': lines('from fastapi import APIRouter as AR', 'r = AR(prefix="/al")', '@r.get("/x")', 'def x(): pass'),
		'app/local.py': lines('class APIRouter:', '    def __init__(self, **kw): pass', 'r = APIRouter(prefix="/lo")', '@r.get("/y")', 'def y(): pass'),
	});
	const shadow = fastapi.buildFastApiShadow(project);
	c.eq('endpoints', [['GET', '/al/x', 'app.aliased']], shadow.endpoints.map((e) => [e.verb, e.path, e.module]));
});

check('fastapi-silent-cases', 'python', (c) => {
	const s = samples();
	const text = FASTAPI_FILES['app/routes.py'];
	const silent = [lineOf(text, '@router.options("/o")'), lineOf(text, '@router.api_route("/ar")'), lineOf(text, 'other.include_router(router)')];
	c.ok('the silent lines were found', silent.every((n) => n > 0) && new Set(silent).size === 3);
	const shadow = s.outputs.fastapi;
	const reported = [...shadow.endpoints, ...shadow.mounts, ...shadow.unknowns].map((x) => x.line);
	c.ok('the shadow reports other lines', reported.length > 10);
	for (const n of silent) c.ok(`line ${n} is not reported`, !reported.includes(n));
	c.ok('an include_router on a declared router is a mount', shadow.mounts.some((m) => m.line === lineOf(text, 'router.include_router(other.r, prefix="/sub")')));
});

check('fastapi-parity-rule-and-keys', 'python', (c) => {
	const legacy = (endpoints, entities = [], dtos = []) => ({ modules: [{ module: 'app.routes', controllers: [{ endpoints }], entities, dtos }] });
	const get = { verb: 'GET', path: '/v1/a', method: 'a', line: 4 };
	const base = ['from fastapi import APIRouter', 'router = APIRouter(prefix="/v1")', '@router.get("/a")', 'def a(): pass'];
	const clean = analyzeProject({ 'app/__init__.py': '', 'app/routes.py': lines(...base) }).project;
	const noisy = analyzeProject({ 'app/__init__.py': '', 'app/routes.py': lines(...base, '@router.post(PATHVAR)', 'def b(): pass') }).project;
	const same = fastapi.diffFastApiShadow(legacy([get]), fastapi.buildFastApiShadow(clean));
	c.eq('equal scans without unknowns', { parity: true, differenceCount: 0, unknowns: 0 }, { parity: same.parity, differenceCount: same.differenceCount, unknowns: same.unknowns.length });
	const unknown = fastapi.diffFastApiShadow(legacy([get]), fastapi.buildFastApiShadow(noisy));
	c.eq('equal scans with one unknown', { parity: false, differenceCount: 0, unknowns: 1 }, { parity: unknown.parity, differenceCount: unknown.differenceCount, unknowns: unknown.unknowns.length });
	const gone = fastapi.diffFastApiShadow(legacy([get, { verb: 'GET', path: '/v1/gone', method: 'gone', line: 9 }]), fastapi.buildFastApiShadow(clean));
	c.eq('a legacy endpoint that the shadow lacks', { parity: false, differenceCount: 1, missing: ['GET /v1/gone#gone'], added: [] }, { parity: gone.parity, differenceCount: gone.differenceCount, missing: gone.differences.endpoints.missingInShadow, added: gone.differences.endpoints.additionalInShadow });
	const models = analyzeProject({
		'app/__init__.py': '', 'app/routes.py': lines(...base),
		'models.py': lines('from sqlmodel import SQLModel, Field', 'class Item(SQLModel, table=True):', '    id: int = Field(primary_key=True)', '    k: int = Field(primary_key=True)', 'class ItemPublic(SQLModel):', '    id: int'),
	}).project;
	const keys = fastapi.diffFastApiShadow(legacy([get], [{ className: 'Item', idField: 'id' }], [{ className: 'Gone' }]), fastapi.buildFastApiShadow(models));
	c.eq('entity keys', { missing: ['Item#id'], added: ['Item#id,k'] }, { missing: keys.differences.entities.missingInShadow, added: keys.differences.entities.additionalInShadow });
	c.eq('dto keys', { missing: ['Gone'], added: ['ItemPublic'] }, { missing: keys.differences.dtos.missingInShadow, added: keys.differences.dtos.additionalInShadow });
	c.eq('report keys', ['counts', 'differenceCount', 'differences', 'parity', 'unknowns'], Object.keys(same).sort());
});

check('flask-silent-cases', 'python', (c) => {
	const s = samples();
	const text = FLASK_FILES['f.py'];
	const silent = [lineOf(text, '@app.add_url_rule("/k")'), lineOf(text, '@app.route'), lineOf(text, '@app.options("/o")')];
	c.ok('the silent lines were found', silent.every((n) => n > 0) && new Set(silent).size === 3);
	const shadow = s.outputs.flask;
	const reported = [...shadow.registrations, ...shadow.unknowns].map((x) => x.line);
	c.ok('the shadow reports other lines', reported.length > 8);
	for (const n of silent) c.ok(`line ${n} is not reported`, !reported.includes(n));
	const base = ['from flask import Flask', 'app = Flask(__name__)', '@app.route("/a")', 'def a(): pass'];
	const plain = flask.buildFlaskRouteShadow(analyzeProject({ 'g.py': lines(...base) }).project);
	const called = analyzeProject({ 'g.py': lines(...base, 'app.add_url_rule("/k", view_func=a)') }).project;
	c.ok('the facts of the module hold the add_url_rule call that the shadow leaves out', called.list().some((m) => (m.facts.calls || []).some((e) => e.line === base.length + 1 && e.value?.callee?.name === 'app.add_url_rule')));
	c.eq('registrations (function: path) before the call', { a: '/a' }, Object.fromEntries(plain.registrations.map((r) => [r.function, r.path])));
	c.eq('the call leaves the result unchanged', plain, flask.buildFlaskRouteShadow(called));
});

check('django-include-without-urlpatterns-is-silent', 'python', (c) => {
	const shadow = samples().outputs.django;
	const edge = shadow.includes.find((i) => i.childModule === 'noconf.views');
	c.eq('the include edge', { from: 'site.urls', line: DJANGO_FILES['site/urls.py'].split('\n').findIndex((l) => l.includes('include("noconf.views")')) + 1, prefix: { kind: 'path', value: 'nc/' }, childModule: 'noconf.views' }, edge);
	c.eq('registrations from the module', [], shadow.registrations.filter((r) => r.module === 'noconf.views'));
	c.eq('diagnostics that name the module', [], shadow.unknowns.filter((u) => JSON.stringify(u).includes('noconf')));
	c.ok('the shadow has other registrations and diagnostics', shadow.registrations.length > 5 && shadow.unknowns.length > 5);
});

check('derived-outputs-carry-no-version-or-id', 'python', (c) => {
	const s = samples();
	const outputs = { project: [...s.projects.resolver.list(), s.projects.resolver.collisions], models: s.outputs.models, typed: s.outputs.typed, fastapi: s.outputs.fastapi, flask: s.outputs.flask, django: s.outputs.django };
	for (const [name, value] of Object.entries(outputs)) {
		const keys = keysDeep(value);
		c.ok(`${name}: keys were visited`, keys.size > 5);
		for (const key of ['schema', 'protocol', 'version', 'id']) c.ok(`${name}: no key ${key}`, !keys.has(key));
	}
	const file = keysDeep(s.outputs.facts);
	c.ok('the analyzer result does carry the protocol key', file.has('protocol') || Object.hasOwn(s.outputs.facts, 'protocol'));
});

check('syntax-support-follows-the-interpreter', 'python', (c) => {
	const root = writeTree({ 'ok.py': 'x = 1\n', 'm.py': lines('match x:', '    case 1:', '        pass') });
	const version = one(root, 'ok.py').runtime?.version;
	c.ok('the interpreter version is a list of at least three integers', Array.isArray(version) && version.length >= 3 && version.every(Number.isInteger));
	const [major = 0, minor = 0] = Array.isArray(version) ? version : [];
	const r = one(root, 'm.py');
	c.eq('a match statement is read exactly when the interpreter is 3.10 or newer', major > 3 || (major === 3 && minor >= 10), r.ok);
	if (!r.ok) c.eq('the code of the failure', 'PYTHON_SYNTAX_ERROR', r.error?.code);
});

check('mounts-are-recorded-not-composed', 'python', (c) => {
	const { project } = analyzeProject({
		'app/__init__.py': '',
		'app/routes.py': lines('from fastapi import APIRouter', 'router = APIRouter(prefix="/v1")', '@router.get("/a")', 'def a(): pass'),
		'app/main.py': lines('from fastapi import FastAPI', 'from app.routes import router', 'app = FastAPI()', 'app.include_router(router, prefix="/api")'),
	});
	const shadow = fastapi.buildFastApiShadow(project);
	c.eq('endpoint (verb, path, module)', [['GET', '/v1/a', 'app.routes']], shadow.endpoints.map((e) => [e.verb, e.path, e.module]));
	c.eq('mounts (module, line, prefix, prefix status)', [['app.main', 4, '/api', 'verified']], shadow.mounts.map((m) => [m.module, m.line, m.prefix, m.prefixStatus]));
	c.eq('diagnostics (kind, reason)', [['fastapi-mount', 'include-router-mount-not-composed']], shadow.unknowns.map((u) => [u.kind, u.reason]));
});

check('flask-register-blueprint-is-not-recorded', 'python', (c) => {
	const base = ['from flask import Flask, Blueprint', 'app = Flask(__name__)', 'bp = Blueprint("bp", __name__, url_prefix="/own")', '@bp.route("/r")', 'def r(): pass', '@app.route("/a")', 'def a(): pass'];
	const plain = flask.buildFlaskRouteShadow(analyzeProject({ 'f.py': lines(...base) }).project);
	const mountedProject = analyzeProject({ 'f.py': lines(...base, 'app.register_blueprint(bp, url_prefix="/api")') }).project;
	const mounted = flask.buildFlaskRouteShadow(mountedProject);
	c.ok('the facts of the module hold the register_blueprint call that the shadow leaves out', mountedProject.list().some((m) => (m.facts.calls || []).some((e) => JSON.stringify(e).includes('register_blueprint'))));
	c.eq('keys of the result', ['declarations', 'registrations', 'unknowns'], Object.keys(mounted).sort());
	c.eq('the call leaves the result unchanged', plain, mounted);
	c.eq('registrations (function: path)', { a: '/a', r: '/own/r' }, Object.fromEntries(mounted.registrations.map((r) => [r.function, r.path])));
	c.eq('limitations (function: notes)', { a: [], r: ['register_blueprint(url_prefix=...) mount overrides are not composed in this shadow slice.'] }, Object.fromEntries(mounted.registrations.map((r) => [r.function, r.limitations])));
	c.eq('diagnostics', [], mounted.unknowns);
	c.ok('the prefix of the call is nowhere in the result', !JSON.stringify(mounted).includes('/api'));
});

check('dynamic-values-are-reported-as-unknown', 'python', (c) => {
	const api = fastapi.buildFastApiShadow(analyzeProject({
		'app/__init__.py': '',
		'app/r.py': lines('from fastapi import APIRouter', 'P = "/x"', 'lit = APIRouter(prefix="/v1")', 'dyn = APIRouter(prefix=P)', '@lit.get(P)', 'def a(): pass', '@lit.get("/ok")', 'def b(): pass', '@dyn.get("/c")', 'def c(): pass'),
	}).project);
	c.eq('FastAPI endpoints (verb, path, method)', [['GET', '/v1/ok', 'b']], api.endpoints.map((e) => [e.verb, e.path, e.method]));
	c.eq('FastAPI diagnostics (line, reason, method)', [[5, 'route-path-not-literal', 'a'], [9, 'router-prefix-not-literal', 'c']], api.unknowns.map((u) => [u.line, u.reason, u.method]));
	const fl = flask.buildFlaskRouteShadow(analyzeProject({
		'f.py': lines('from flask import Flask, Blueprint', 'app = Flask(__name__)', 'P = "/x"', 'M = ["GET"]', '@app.route(P)', 'def a(): pass', '@app.route("/y", methods=M)', 'def b(): pass', 'bp = Blueprint("bp", __name__, url_prefix=P)', '@bp.route("/z")', 'def c(): pass', '@app.route("/ok")', 'def d(): pass'),
	}).project);
	c.eq('Flask registrations (function, path)', [['d', '/ok']], fl.registrations.map((r) => [r.function, r.path]));
	c.eq('Flask diagnostics (line, reason, function)', [[5, 'route-path-not-literal', 'a'], [7, 'methods-not-literal-sequence', 'b'], [10, 'blueprint-prefix-not-literal', 'c']], fl.unknowns.map((u) => [u.line, u.reason, u.function]));
	const dj = django.buildDjangoUrlShadow(analyzeProject({
		'proj/__init__.py': '', 'proj/views.py': 'def view(request): pass\n',
		'proj/urls.py': lines('from django.urls import path', 'from proj.views import view', 'P = "x/"', 'urlpatterns = [path(P, view), path("ok/", view)]'),
	}).project);
	c.eq('Django registrations (line, segments)', [[4, [{ kind: 'path', value: 'ok/' }]]], dj.registrations.map((r) => [r.line, r.patternSegments]));
	c.eq('Django diagnostics (kind, reason)', [['django-urlpattern', 'route-pattern-not-literal']], dj.unknowns.map((u) => [u.kind, u.reason]));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const clean = (what, c) => {
	assert.ok(c.checks > 0, `${what}: no check ran`);
	assert.equal(c.problems.length, 0, `${what}: ${c.problems.length} problem(s) in ${c.checks} checks\n${c.problems.slice(0, 12).join('\n')}`);
};
const expectProblem = (c, fragment) => {
	assert.ok(c.checks > 0, 'no check ran');
	assert.ok(c.problems.some((p) => p.includes(fragment)), `no problem mentions "${fragment}"; found: ${c.problems.slice(0, 4).join(' | ') || 'none'}`);
};
const edited = (fn) => { const v = structuredClone(vocab); fn(v); return v; };
const without = (text, fragment) => { assert.ok(text.includes(fragment), `the document does not contain "${fragment}"`); return text.replace(fragment, ''); };
const replaced = (text, from, to) => { assert.ok(text.includes(from), `the document does not contain "${from}"`); return text.replace(from, to); };

test('T06-02 code: files, exports, signatures, protocols, defaults, options and imports match the vocabulary', () => {
	clean('code', codeProblems(vocab));
});

test('T06-02 code: word properties, code names and unreachable literals match the vocabulary', () => {
	clean('words', codeWordProblems(vocab));
});

test('T06-02 samples: shape keys, words, diagnostic keys and sample tables are recomputed by calls of the real code', async (t) => {
	if (!POSIX) return t.skip('the samples use shell-script stand-ins for the interpreter');
	if (!lib.need(t, runtime)) return;
	clean('samples', sampleProblems(vocab));
});

test('T06-02 document: rendered tables, headings, vocabulary, paths and banned text', () => {
	clean('document', rfcProblems(vocab));
});

test('T06-02 README: short pointer to the document and the baseline record', () => {
	clean('README', readmeProblems(vocab));
});

test('T06-02 ownership: the T06 scopes pass the gate and each neighbour is reported with its owner', () => {
	clean('ownership', ownershipProblems(vocab));
});

test('T06-02 consumers: the listed neighbours exist and name the layer files the document says they name', () => {
	clean('consumers', consumerProblems(vocab));
});

test('T06-02 registry: claims, checks, identities, limits and obligations agree', () => {
	clean('registry', registerProblems(vocab));
});

test('T06-02 baseline library lists this test and its vocabulary among the own files of the track', () => {
	for (const f of ['test/language-python/interface-rfc.test.mjs', 'test/language-python/interface-rfc.vocabulary.json']) assert.ok(lib.TRACK.ownFiles.includes(f), `${f} is not in TRACK.ownFiles`);
});

for (const [id, needs] of vocab.claims) {
	test(`T06-02 claim ${id}`, async (t) => {
		const entry = CHECKS[id];
		assert.ok(entry, `no check is registered for ${id}`);
		if (needs === 'posix' && !POSIX) return t.skip('needs a POSIX shell for the stand-in interpreters');
		if (needs === 'python' && !lib.need(t, runtime)) return;
		// A check that uses stand-in interpreters depends on the analyzer's own 1500 ms probe of them. On a heavily loaded host that probe can time out, so such a check is run again (at most twice more) and fails only if it fails every time.
		let c;
		for (let attempt = 1; attempt <= (needs === 'posix' ? 3 : 1); attempt += 1) {
			c = collector();
			entry.run(c, vocab);
			if (c.problems.length === 0) break;
		}
		clean(id, c);
	});
}

// ---------------------------------------------------------------------------
// The unreadable-file case of the claim argument-errors-are-thrown-not-returned. A process that can read a file of mode 000 (root, or any other
// permission bypass) cannot make the fixture unreadable, so the test is reported as skipped with a reason there. For an ordinary user it runs.
// ---------------------------------------------------------------------------
const UNREADABLE_SKIP_REASON = 'this process can read a file of mode 000 (root or a permission bypass), so the unreadable-file fixture is not available';
const unreadableFixtureSkip = (platform, access, file) => {
	if (platform === 'win32') return 'mode bits do not make a file unreadable on Windows';
	try { access(file, fs.constants.R_OK); } catch { return false; }
	return UNREADABLE_SKIP_REASON;
};
const unreadableFixture = memo(() => {
	const root = writeTree({ 'locked.py': 'l = 1\n' });
	const file = path.join(root, 'locked.py');
	fs.chmodSync(file, 0o000);
	return { root, file, skip: unreadableFixtureSkip(process.platform, fs.accessSync, file) };
});

test('T06-02 an unreadable source file throws the raw EACCES error (skipped with a reason where the process can read a file of mode 000)', { skip: unreadableFixture().skip }, () => {
	const { root } = unreadableFixture();
	const c = collector();
	for (const [what, fn] of [['an unreadable file', () => one(root, 'locked.py')], ['an unreadable file in a batch', () => many(root, ['locked.py'])]]) {
		const error = thrown(fn);
		c.eq(`${what} throws the raw system error`, 'EACCES', error?.code);
		c.ok(`${what}: the message starts with EACCES`, String(error?.message).startsWith('EACCES'));
	}
	clean('EACCES', c);
});

test('T06-02 the unreadable-file test is skipped with a reason where a mode 000 file stays readable, and runs where it does not', () => {
	const c = collector();
	const denied = () => { throw Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' }); };
	const seen = [];
	c.eq('an access check that fails: the test runs', false, unreadableFixtureSkip('linux', (file, mode) => { seen.push([file, mode]); denied(); }, 'f'));
	c.eq('the access check asks for read permission', [['f', fs.constants.R_OK]], seen);
	c.eq('an access check that fails on darwin: the test runs', false, unreadableFixtureSkip('darwin', denied, 'f'));
	const readable = unreadableFixtureSkip('linux', () => undefined, 'f');
	c.ok('an access check that passes (root or a bypass): a reason string', typeof readable === 'string' && readable.length > 40);
	c.ok('the reason names the cause', /mode 000/.test(readable) && /root/.test(readable));
	const windows = unreadableFixtureSkip('win32', denied, 'f');
	c.ok('on Windows: a reason string', typeof windows === 'string' && /Windows/.test(windows));
	const fixture = unreadableFixture();
	c.ok('the value of the registered test is false or a reason string', fixture.skip === false || (typeof fixture.skip === 'string' && fixture.skip.length > 40));
	if (POSIX) {
		let canRead = true;
		try { fs.accessSync(fixture.file, fs.constants.R_OK); } catch { canRead = false; }
		c.eq('the registered value is a reason string exactly where a direct read-access check of the fixture succeeds', canRead, typeof fixture.skip === 'string');
	}
	clean('EACCES skip', c);
});

// ---------------------------------------------------------------------------
// Negative tests: each kind of drift must be reported, so a passing run is not a vacuous one.
// ---------------------------------------------------------------------------
test('T06-02 negative code: edited vocabulary rows are reported', () => {
	expectProblem(codeProblems(edited((v) => { v.exports = v.exports.filter((e) => e[0] !== 'analyzePythonFile'); })), 'analyzer.mjs export names');
	expectProblem(codeProblems(edited((v) => { v.exports.find((e) => e[0] === 'findPythonRuntime')[2] = '{ pythonCommand = null } = {}'; })), 'findPythonRuntime signature');
	expectProblem(codeProblems(edited((v) => { v.protocols[0][1] = 'bskel.python-ast.request/2'; })), 'PYTHON_AST_REQUEST_PROTOCOL value');
	expectProblem(codeProblems(edited((v) => { v.defaults[0][2] = 1; })), 'DEFAULT_ constants');
	expectProblem(codeProblems(edited((v) => { v.options.find((o) => o[0] === 'timeoutMs')[2] = 'none'; })), 'option timeoutMs: default');
	expectProblem(codeProblems(edited((v) => { v.options.find((o) => o[0] === 'maxFiles')[1] = 'analyzePythonFile, analyzePythonFiles'; })), 'option maxFiles: functions that take it');
	expectProblem(codeProblems(edited((v) => { v.files.push(['extra.mjs', 'x']); })), 'files: vocabulary vs directory listing');
	expectProblem(codeProblems(edited((v) => { delete v.consumers; })), 'vocabulary keys');
});

test('T06-02 negative words: a word that the code writes but the vocabulary lacks is reported', () => {
	expectProblem(codeWordProblems(edited((v) => { delete v.words.code.items.PYTHON_ANALYZER_TIMEOUT; })), 'code words written in the sources');
	expectProblem(codeWordProblems(edited((v) => { delete v.words.status.items.resolved; })), 'status: literals written after the property name');
	expectProblem(codeWordProblems(edited((v) => { v.words.status.items.verified = 'x'; })), 'status: internal literals that the vocabulary names');
	expectProblem(codeWordProblems(edited((v) => { v.unreachable[0][3] = 'text that no file contains'; })), 'writes text that no file contains');
});

test('T06-02 negative samples: edited tables of the vocabulary are reported', async (t) => {
	if (!POSIX) return t.skip('the samples use shell-script stand-ins for the interpreter');
	if (!lib.need(t, runtime)) return;
	expectProblem(sampleProblems(edited((v) => { v.shapes['source reference'].keys.push('extra'); })), 'object group source reference');
	expectProblem(sampleProblems(edited((v) => { delete v.shapes['source reference']; })), 'object group source reference');
	expectProblem(sampleProblems(edited((v) => { delete v.words.status.items.resolved; })), 'status words');
	expectProblem(sampleProblems(edited((v) => { v.words.reason.items.invented = 'x'; })), 'reason words');
	expectProblem(sampleProblems(edited((v) => { v.unreachable = v.unreachable.filter((u) => u[1] !== 'INVALID_REQUEST'); })), 'code words');
	expectProblem(sampleProblems(edited((v) => { delete v.diagnostics['flask-route methods-not-literal-sequence']; })), 'diagnostic flask-route methods-not-literal-sequence keys');
	expectProblem(sampleProblems(edited((v) => { v.moduleIds[0][1] = 'other'; })), 'module ids');
	expectProblem(sampleProblems(edited((v) => { v.localities[0][1] = 'local'; })), 'module localities');
	expectProblem(sampleProblems(edited((v) => { v.resolutions[0][3] = '{}'; })), 'symbol resolutions');
	expectProblem(sampleProblems(edited((v) => { v.expressions[0][1] = '{}'; })), 'expressions');
});

test('T06-02 negative document: edited text of the document is reported', () => {
	const row = rfc.split('\n').find((l) => l.startsWith('| `analyzePythonFile`'));
	assert.ok(row, 'the export table has a row for analyzePythonFile');
	expectProblem(rfcProblems(vocab, without(rfc, `${row}\n`)), 'rendered blocks that are missing');
	expectProblem(rfcProblems(vocab, `${rfc}\n| invented | table |\n| --- | --- |\n| a | b |\n`), 'table blocks of the document that no rendered table produces');
	const prose = rfc.split('\n').find((l) => l.startsWith('The layer is static.'));
	assert.ok(prose, 'the document has the paragraph that starts with "The layer is static."');
	expectProblem(rfcProblems(vocab, replaced(rfc, prose, `${prose}\n| invented | row |`)), 'lines that start with a table bar');
	expectProblem(rfcProblems(vocab, replaced(rfc, '## Safety', '## Security')), 'level 2 headings');
	expectProblem(rfcProblems(vocab, replaced(rfc, TITLE, '# Python layer')), 'title');
	expectProblem(rfcProblems(vocab, replaced(rfc, 'claim `numeric-and-depth-rules`', 'claim `numeric-rules`')), 'ids cited after the word claim or limit');
	expectProblem(rfcProblems(vocab, replaced(rfc, 'limit `resolved-names-are-not-checked`', 'limit `resolved-names-are-fine`')), 'ids cited after the word claim or limit');
	expectProblem(rfcProblems(vocab, `${rfc}\nSee ${String.fromCharCode(35)}12 for details.\n`), 'contains no a number sign followed by a digit');
	expectProblem(rfcProblems(vocab, `${rfc}\nSee ${['PR', '7'].join(' ')}.\n`), 'a pull request number');
	expectProblem(rfcProblems(vocab, `${rfc}\nThe digest is ${'ab'.repeat(32)}.\n`), 'a 64-digit hex string');
	expectProblem(rfcProblems(vocab, `${rfc}\nChecked in ${['', 'Users', 'someone', 'work'].join('/')}.\n`), 'a home directory path');
	expectProblem(rfcProblems(vocab, `${rfc}\nThe option fooBarBaz is new.\n`), 'identifier-like words that no source');
	expectProblem(rfcProblems(vocab, `${rfc}\nSee scanners/language/python/nothing.mjs.\n`), 'cited path scanners/language/python/nothing.mjs exists');
	expectProblem(rfcProblems(vocab, `${rfc}\nSee notes-file.mjs.\n`), 'file name notes-file.mjs is a layer file');
	expectProblem(rfcProblems(vocab, `${rfc}\nSee next/t99/**.\n`), 'wildcard next/t99/** is an ownership scope');
	expectProblem(rfcProblems(edited((v) => { v.rfc.maxLines = 10; })), 'document has at most 10 lines');
	expectProblem(rfcProblems(edited((v) => { v.terms.push('notAWordAnywhere_x'); })), 'term notAWordAnywhere_x');
});

test('T06-02 negative README: edited text of the README is reported', () => {
	expectProblem(readmeProblems(vocab, without(readme, 'INTERFACE_RFC.md')), 'README names INTERFACE_RFC.md');
	expectProblem(readmeProblems(vocab, without(readme, 'BASELINE.json')), 'README names BASELINE.json');
	expectProblem(readmeProblems(vocab, `${readme}\n| a | b |\n`), 'README has no table row');
	expectProblem(readmeProblems(vocab, `${readme}${'\nline'.repeat(40)}\n`), 'README has at most 30 lines');
	expectProblem(readmeProblems(vocab, `${readme}\nSee scanners/language/python/gone.md.\n`), 'cited path scanners/language/python/gone.md exists');
	const paragraph = rfc.split(/\n\s*\n/).find((b) => b.length >= 120 && !b.startsWith('|') && !b.startsWith('#') && !b.includes('\n'));
	assert.ok(paragraph, 'the document has a long single-line paragraph');
	expectProblem(readmeProblems(vocab, `${readme}\n${paragraph}\n`), 'README paragraphs of 80 characters or more that the document repeats');
});

test('T06-02 negative ownership and consumers: edited rows are reported', () => {
	expectProblem(ownershipProblems(edited((v) => { v.ownership.find((o) => o[2] !== 'T06' && o[2] !== 'UNOWNED' && o[2] !== 'RESERVED')[2] = 'T06'; })), 'gate exit code for the T06 paths');
	expectProblem(ownershipProblems(edited((v) => { const o = v.ownership.find((x) => x[2] !== 'T06' && x[2] !== 'UNOWNED' && x[2] !== 'RESERVED'); o[2] = o[2] === 'T11' ? 'T12' : 'T11'; })), 'the gate reports');
	expectProblem(ownershipProblems(edited((v) => { v.ownership.find((o) => o[0].startsWith('next/'))[0] = 'next/t99/**'; })), 'ownership map: plan scopes of T06');
	expectProblem(consumerProblems(edited((v) => { v.consumers.find((x) => x[1] === 'import')[2].push('nothing.mjs'); })), 'layer files imported');
	expectProblem(consumerProblems(edited((v) => { v.consumers[0][0] = 'adapters/nothing.mjs'; })), 'exists');
	expectProblem(consumerProblems(edited((v) => { v.recognised[0][1] = 'notAName'; })), 'contains notAName');
});

test('T06-02 negative registry: edited claims, limits and obligations are reported', () => {
	expectProblem(registerProblems(edited((v) => { v.claims.pop(); })), 'claims of the vocabulary vs checks of the test');
	expectProblem(registerProblems(edited((v) => { v.claims[0][1] = 'maybe'; })), 'needs is one of');
	expectProblem(registerProblems(edited((v) => { v.claims[0][1] = v.claims[0][1] === 'none' ? 'static' : 'none'; })), 'needs agrees with the check');
	expectProblem(registerProblems(edited((v) => { v.claims.push(v.claims[0].slice()); })), 'claim ids are unique');
	expectProblem(registerProblems(edited((v) => { v.limits[0][1] = 'SUPPORTED'; })), 'is a limit status of the baseline library');
	expectProblem(registerProblems(edited((v) => { v.limits[0][3] = 'no-such-claim'; })), 'is checked by a claim or stated');
	expectProblem(registerProblems(edited((v) => { v.identity[0][5] = 'no-such-claim'; })), 'is checked by a claim');
	expectProblem(registerProblems(edited((v) => { v.obligations[0][0] = 'T06-01'; })), 'is open, so no other test of the directory names it');
	expectProblem(registerProblems(edited((v) => { v.obligations[0][1] = 'team six'; })), 'the owner is a track id');
});

const runClaim = (id, fn) => { const c = collector(); CHECKS[id].run(c, edited(fn)); return c; };

test('T06-02 negative claims: an edited message or option row is reported by the check that provokes it', async (t) => {
	if (!POSIX) return t.skip('needs a POSIX shell for the stand-in interpreters');
	expectProblem(runClaim('argument-errors-are-thrown-not-returned', (v) => { v.errors[0][1] = 'something else'; }), 'messages of the errors table');
	expectProblem(runClaim('limits-are-validated-before-any-file-is-read', (v) => { v.options.find((o) => o[0] === 'timeoutMs')[4] = 'timeoutMs must be an integer between 1 and 60000'; }), 'timeoutMs');
	expectProblem(runClaim('helper-and-analyzer-agree-on-protocols', (v) => { v.protocols[2][1] = 'bskel.python-ast.batch-response/2'; }), 'ends with /1');
});

test('T06-02 negative claims that need the helper: an edited or an added module id row is reported by the check that provokes it', async (t) => {
	if (!lib.need(t, runtime)) return;
	expectProblem(runClaim('module-ids-come-from-paths', (v) => { v.moduleIds[0][1] = 'other'; }), 'module id of');
	expectProblem(runClaim('module-ids-come-from-paths', (v) => { v.moduleIds.push(['extra/zz.py', 'extra.zz', 'extra', false]); }), 'listed paths of the sample project');
});
