// D-http-serving-layer: a native node:http server (zero new dependencies -- this package ships no
// web framework) exposing read/write JSON endpoints over the field-dependency data model, plus a
// minimal bundled sanity-check UI page. Every route handler calls straight into the SAME lib/
// functions bin/bskel.mjs's CLI commands call (declareDependency/removeDependency/
// buildDependencyListReport/listFeatures/computeWorkflowState) -- there is no second copy of any
// business logic here, only HTTP transport (routing, CORS, JSON (de)serialization). See
// DECISIONS.md's D-http-serving-layer for the full design and the CORS-asymmetry security reasoning.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFeatures } from './featurelifecycle.mjs';
import { computeWorkflowState } from './workflow.mjs';
import { isValidFeatureId } from './featureid.mjs';
import {
	buildDependencyListReport, buildDependencyGraph, declareDependency, removeDependency, DependencyOperationError,
} from './field-dependencies.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = path.join(__dirname, 'serve-ui.html');

// GET/HEAD/their own OPTIONS preflight get the wildcard; POST/DELETE never do -- an unrestricted
// Access-Control-Allow-Origin on a mutating route would let any website a user's browser has open
// silently mutate their repo via a background fetch. The bundled UI page (served BY this same
// server) is same-origin and completely unaffected -- CORS only ever applies cross-origin.
const CORS_METHODS = new Set(['GET', 'HEAD']);

function sendJson(res, status, body, { cors = false } = {}) {
	const payload = JSON.stringify(body, null, 2);
	const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) };
	if (cors) headers['Access-Control-Allow-Origin'] = '*';
	res.writeHead(status, headers);
	res.end(payload);
}

function sendError(res, err, { cors = false } = {}) {
	if (err instanceof DependencyOperationError) {
		sendJson(res, err.httpStatus, { error: err.message, reasonCode: err.reasonCode }, { cors });
		return;
	}
	// D-http-serving-layer: everything user-input-shaped throws DependencyOperationError (see
	// requireValidFeatureIdOr400 in lib/field-dependencies.mjs) -- reaching here means a genuine,
	// unexpected failure (e.g. a filesystem error), so 500 is the honest answer, not a guess.
	sendJson(res, 500, { error: err.message ?? 'internal error' }, { cors });
}

// Bounds the body a single request can force this process to buffer -- a local,
// single-user dev server still shouldn't let an unbounded body exhaust memory.
const MAX_BODY_BYTES = 1_000_000;

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new DependencyOperationError(`request body exceeds ${MAX_BODY_BYTES} bytes`, { httpStatus: 413, reasonCode: 'BAD_ARGS' }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (chunks.length === 0) { resolve({}); return; }
			let parsed;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				reject(new DependencyOperationError('request body is not valid JSON', { httpStatus: 400, reasonCode: 'BAD_ARGS' }));
				return;
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				reject(new DependencyOperationError('request body must be a JSON object', { httpStatus: 400, reasonCode: 'BAD_ARGS' }));
				return;
			}
			resolve(parsed);
		});
		req.on('error', reject);
	});
}

let uiHtmlCache = null;
function serveUiPage(res) {
	if (uiHtmlCache === null) uiHtmlCache = fs.readFileSync(UI_HTML_PATH, 'utf8');
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(uiHtmlCache) });
	res.end(uiHtmlCache);
}

const FEATURE_STATUS_RE = /^\/api\/features\/([^/]+)\/status$/;
const FEATURE_DEPENDENCIES_RE = /^\/api\/features\/([^/]+)\/dependencies$/;

async function handleRequest(root, req, res) {
	let url;
	try {
		url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
	} catch {
		sendJson(res, 400, { error: 'invalid request URL' });
		return;
	}
	const { pathname } = url;
	const method = req.method ?? 'GET';
	const cors = CORS_METHODS.has(method);

	if (method === 'OPTIONS') {
		const headers = { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
		// Only ever grant a preflight for GET-eligible routes -- a POST/DELETE preflight gets no
		// Access-Control-Allow-Origin, so the browser refuses to send the real cross-origin write.
		if (pathname === '/' || pathname.startsWith('/api/')) headers['Access-Control-Allow-Origin'] = '*';
		res.writeHead(204, headers);
		res.end();
		return;
	}

	try {
		if (method === 'GET' && pathname === '/') { serveUiPage(res); return; }
		if (method === 'GET' && pathname === '/api/health') { sendJson(res, 200, { status: 'ok', repo: root }, { cors }); return; }
		if (method === 'GET' && pathname === '/api/features') { sendJson(res, 200, { features: listFeatures(root) }, { cors }); return; }
		if (method === 'GET' && pathname === '/api/graph') { sendJson(res, 200, buildDependencyGraph(root), { cors }); return; }

		const statusMatch = pathname.match(FEATURE_STATUS_RE);
		if (method === 'GET' && statusMatch) {
			const featureId = decodeURIComponent(statusMatch[1]);
			if (!isValidFeatureId(featureId)) { sendJson(res, 400, { error: `invalid feature id "${featureId}"` }, { cors }); return; }
			sendJson(res, 200, computeWorkflowState(root, featureId), { cors });
			return;
		}

		const depsMatch = pathname.match(FEATURE_DEPENDENCIES_RE);
		if (depsMatch) {
			const featureId = decodeURIComponent(depsMatch[1]);
			if (!isValidFeatureId(featureId)) { sendJson(res, 400, { error: `invalid feature id "${featureId}"` }, { cors }); return; }

			if (method === 'GET') { sendJson(res, 200, buildDependencyListReport(root, featureId), { cors }); return; }
			if (method === 'POST') {
				const body = await readJsonBody(req);
				const result = declareDependency(root, { feature: featureId, ...body });
				sendJson(res, 201, result); // no CORS -- mutating route, same-origin only
				return;
			}
			if (method === 'DELETE') {
				const body = await readJsonBody(req);
				const result = removeDependency(root, { feature: featureId, ...body });
				sendJson(res, 200, result); // no CORS -- mutating route
				return;
			}
		}

		sendJson(res, 404, { error: `not found: ${method} ${pathname}` }, { cors });
	} catch (err) {
		sendError(res, err, { cors });
	}
}

// Default host 127.0.0.1 (loopback only) -- explicit --host opt-in required to expose beyond it,
// matching this project's established "safe default, explicit override" convention (e.g.
// --enforce-registry). Returns once the server has actually bound (server.address() is real), not
// merely once listen() was called -- callers (bin/bskel.mjs's cmdServe, tests) need the REAL bound
// port when 0 was requested.
export function createHttpServer(root, { host = '127.0.0.1', port = 4747 } = {}) {
	const server = http.createServer((req, res) => {
		handleRequest(root, req, res).catch((err) => sendError(res, err));
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			server.removeListener('error', reject);
			const addr = server.address();
			resolve({ server, host: addr.address, port: addr.port, url: `http://${addr.address}:${addr.port}` });
		});
	});
}
