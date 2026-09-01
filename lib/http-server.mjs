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
import { introspectSchema, describeConnectionError } from '../scanners/db/introspect.mjs';
import {
	proposeTransaction, approveTransaction, applyTransaction, rollbackTransaction, loadTransaction, listTransactions, transactionsDir,
} from './patch-transactions.mjs';
import { getPatchKind, replanTransaction, PATCH_KIND_NAMES } from './patch-kinds.mjs';
import { requireNamedGate, passNamedGate, EXIT } from './gates.mjs';
import { signPayload } from './attest.mjs';
import { writeFileAtomic } from './fsutil.mjs';

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

// D-ddl-apply: every route below is gated behind `dbConfig` being non-null (only true when
// `bskel serve --database-url-env <NAME>` was given) -- a plain `bskel serve` never even matches
// these paths (falls through to the existing 404), matching --host's own "safe default, explicit
// override" convention. NONE of these routes ever get CORS, GET included -- a deliberate deviation
// from CORS_METHODS' plain-GET-gets-wildcard convention above: live schema/table names and raw SQL
// text are not the same sensitivity class as the git-tracked JSON dependency record that
// convention was scoped against (see DECISIONS.md D-ddl-apply).
const DB_SCHEMA_RE = /^\/api\/db\/schema$/;
const PATCH_TRANSACTIONS_RE = /^\/api\/features\/([^/]+)\/patch-transactions$/;
const PATCH_PROPOSE_RE = /^\/api\/features\/([^/]+)\/patch-transactions\/propose$/;
const PATCH_TXN_ACTION_RE = /^\/api\/features\/([^/]+)\/patch-transactions\/([^/]+)\/(approve|apply|rollback)$/;
const TRANSACTION_ID_RE = /^pt-[0-9a-f-]{36}$/;

function paramsAndSourceFromProposeBody(kind, body) {
	if (kind === 'config-apply') {
		if (!body.choice || !body.target) {
			throw new DependencyOperationError('propose --kind config-apply requires {choice, target}', { httpStatus: 400, reasonCode: 'BAD_ARGS' });
		}
		return { params: { choice: body.choice, target: body.target }, source: { choice: body.choice } };
	}
	if (kind === 'ddl-apply') {
		if (!body.databaseUrlEnv || !body.sqlText) {
			throw new DependencyOperationError('propose --kind ddl-apply requires {databaseUrlEnv, sqlText}', { httpStatus: 400, reasonCode: 'BAD_ARGS' });
		}
		const schema = body.schema || 'public';
		return { params: { databaseUrlEnv: body.databaseUrlEnv, schema, sqlText: body.sqlText }, source: { database_url_env: body.databaseUrlEnv, schema } };
	}
	throw new DependencyOperationError(`unknown kind "${kind}" -- known kinds: ${PATCH_KIND_NAMES.join(', ')}`, { httpStatus: 400, reasonCode: 'BAD_ARGS' });
}

// D-ddl-apply audit trail: optional (only when `--sign-key` was given at `bskel serve` startup),
// server-held-key signing of every propose/approve/apply/rollback-refusal touching a `ddl-apply`
// transaction -- the browser can never hold a private key, so the server process itself signs, per
// this feature's own design (see DECISIONS.md D-ddl-apply). lib/attest.mjs itself needs no changes
// -- it's already genuinely payload-shape-agnostic. Deliberately best-effort/non-fatal: a signing
// failure must not roll back or hide an otherwise-successful propose/approve/apply.
let signKeyCache = null;
function loadSignKey(signKeyPath) {
	if (signKeyCache === null) signKeyCache = fs.readFileSync(signKeyPath, 'utf8');
	return signKeyCache;
}

function maybeSignStep(root, dbConfig, txn, step) {
	if (!dbConfig?.signKeyPath || txn.kind !== 'ddl-apply') return;
	try {
		const privateKeyPem = loadSignKey(dbConfig.signKeyPath);
		const payload = {
			transaction_id: txn.transaction_id,
			feature_id: txn.feature_id,
			kind: txn.kind,
			status: txn.status,
			sql_text: txn.target.sql_text,
			schema_hash: txn.preimage.region_hash,
			reason: txn.approval?.reason ?? txn.rollback?.reason ?? null,
			at: new Date().toISOString(),
		};
		const signature = signPayload(payload, privateKeyPem);
		const sigPath = path.join(transactionsDir(root, txn.feature_id), `${txn.transaction_id}.${step}.sig.json`);
		writeFileAtomic(sigPath, `${JSON.stringify({ payload, signature: { algorithm: 'ed25519', value: signature } }, null, 2)}\n`);
	} catch (err) {
		console.error(`warning: could not sign patch-transaction step "${step}" for "${txn.transaction_id}": ${err.message}`);
	}
}

function requirePreflightPassedHttp(root) {
	const result = requireNamedGate(root, 'preflight', null);
	if (result.code !== EXIT.PASS) {
		throw new DependencyOperationError(`blocked: \`preflight\` gate is ${result.status} -- run \`bskel preflight\` first`, { httpStatus: 409, reasonCode: 'GATE_NOT_PASSED' });
	}
}

async function handleDbRoutes(root, dbConfig, method, pathname, req, res) {
	if (method === 'GET' && DB_SCHEMA_RE.test(pathname)) {
		const connectionString = process.env[dbConfig.databaseUrlEnv];
		let live;
		try {
			live = await introspectSchema({ connectionString, schema: dbConfig.schema });
		} catch (err) {
			throw new DependencyOperationError(`could not introspect the live database: ${describeConnectionError(err)}`, { httpStatus: 502, reasonCode: 'REFRESH_FAILED' });
		}
		sendJson(res, 200, live, { cors: false });
		return true;
	}

	const listMatch = pathname.match(PATCH_TRANSACTIONS_RE);
	if (method === 'GET' && listMatch) {
		const featureId = decodeURIComponent(listMatch[1]);
		if (!isValidFeatureId(featureId)) { sendJson(res, 400, { error: `invalid feature id "${featureId}"` }, { cors: false }); return true; }
		sendJson(res, 200, { feature: featureId, transactions: listTransactions(root, featureId) }, { cors: false });
		return true;
	}

	const proposeMatch = pathname.match(PATCH_PROPOSE_RE);
	if (method === 'POST' && proposeMatch) {
		const featureId = decodeURIComponent(proposeMatch[1]);
		if (!isValidFeatureId(featureId)) { sendJson(res, 400, { error: `invalid feature id "${featureId}"` }, { cors: false }); return true; }
		const body = await readJsonBody(req);
		const kind = body.kind || 'config-apply';
		const { params, source } = paramsAndSourceFromProposeBody(kind, body);
		const plan = await getPatchKind(kind).planFresh(root, params);
		const txn = proposeTransaction(root, featureId, kind, plan, source);
		maybeSignStep(root, dbConfig, txn, 'propose');
		sendJson(res, 201, txn, { cors: false });
		return true;
	}

	const actionMatch = pathname.match(PATCH_TXN_ACTION_RE);
	if (method === 'POST' && actionMatch) {
		const featureId = decodeURIComponent(actionMatch[1]);
		const transactionId = decodeURIComponent(actionMatch[2]);
		const action = actionMatch[3];
		if (!isValidFeatureId(featureId)) { sendJson(res, 400, { error: `invalid feature id "${featureId}"` }, { cors: false }); return true; }
		if (!TRANSACTION_ID_RE.test(transactionId)) { sendJson(res, 400, { error: `invalid transaction id "${transactionId}"` }, { cors: false }); return true; }
		const txn = loadTransaction(root, featureId, transactionId);
		if (!txn) { sendJson(res, 404, { error: `no patch transaction "${transactionId}" for feature "${featureId}"` }, { cors: false }); return true; }
		const body = await readJsonBody(req);

		if (action === 'approve') {
			if (!body.reason || !String(body.reason).trim()) {
				throw new DependencyOperationError('approve requires {reason}', { httpStatus: 400, reasonCode: 'BAD_ARGS' });
			}
			const freshPlan = await replanTransaction(root, txn);
			const updated = approveTransaction(root, featureId, transactionId, body.reason, freshPlan);
			maybeSignStep(root, dbConfig, updated, 'approve');
			sendJson(res, 200, updated, { cors: false });
			return true;
		}
		if (action === 'apply') {
			// D-ddl-apply: {confirm} must exactly equal the transaction id for any kind other than
			// config-apply -- the same human-factors friction cmdPatchApply enforces at the CLI
			// boundary, checked here BEFORE applyTransaction() is ever called, layered on top of
			// (not instead of) the engine's own preimage-hash TOCTOU re-check.
			if (txn.kind !== 'config-apply' && body.confirm !== transactionId) {
				throw new DependencyOperationError(`apply requires {confirm} to exactly equal the transaction id ("${transactionId}") for kind "${txn.kind}"`, { httpStatus: 400, reasonCode: 'BAD_ARGS' });
			}
			requirePreflightPassedHttp(root);
			const freshPlan = await replanTransaction(root, txn);
			const updated = await applyTransaction(root, featureId, transactionId, freshPlan, getPatchKind(txn.kind).apply);
			maybeSignStep(root, dbConfig, updated, 'apply');
			passNamedGate(root, 'patch_transactions', featureId, { transaction_id: updated.transaction_id, kind: updated.kind, applied_at: updated.apply.at });
			sendJson(res, 200, updated, { cors: false });
			return true;
		}
		if (action === 'rollback') {
			if (!body.reason || !String(body.reason).trim()) {
				throw new DependencyOperationError('rollback requires {reason}', { httpStatus: 400, reasonCode: 'BAD_ARGS' });
			}
			requirePreflightPassedHttp(root);
			const updated = await rollbackTransaction(root, featureId, transactionId, body.reason, { force: Boolean(body.force) }, getPatchKind(txn.kind).rollback);
			maybeSignStep(root, dbConfig, updated, 'rollback');
			passNamedGate(root, 'patch_transactions', featureId, { transaction_id: updated.transaction_id, kind: updated.kind, rolled_back_at: updated.rollback.at });
			sendJson(res, 200, updated, { cors: false });
			return true;
		}
	}

	return false;
}

function isDbRoutePath(pathname) {
	return DB_SCHEMA_RE.test(pathname) || PATCH_TRANSACTIONS_RE.test(pathname) || PATCH_PROPOSE_RE.test(pathname) || PATCH_TXN_ACTION_RE.test(pathname);
}

async function handleRequest(root, req, res, dbConfig) {
	let url;
	try {
		url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
	} catch {
		sendJson(res, 400, { error: 'invalid request URL' });
		return;
	}
	const { pathname } = url;
	const method = req.method ?? 'GET';
	// D-ddl-apply: CORS withheld unconditionally on every DB/patch-transaction route, GET included
	// -- see the comment above DB_SCHEMA_RE for why this deviates from CORS_METHODS' plain-GET-
	// gets-wildcard convention.
	const cors = CORS_METHODS.has(method) && !isDbRoutePath(pathname);

	if (method === 'OPTIONS') {
		const headers = { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
		// Only ever grant a preflight for GET-eligible routes -- a POST/DELETE preflight gets no
		// Access-Control-Allow-Origin, so the browser refuses to send the real cross-origin write.
		// DB/patch-transaction routes never grant it either, regardless of method (see above).
		if ((pathname === '/' || pathname.startsWith('/api/')) && !isDbRoutePath(pathname)) headers['Access-Control-Allow-Origin'] = '*';
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

		// D-ddl-apply: only reachable at all when `bskel serve --database-url-env` was given --
		// otherwise dbConfig is null and every one of these paths simply falls through to the same
		// 404 below as any other unmatched route (not a 403 -- matches --host's own "safe default,
		// explicit override" convention: a plain `bskel serve` behaves exactly as it did before
		// this feature existed).
		if (dbConfig && (await handleDbRoutes(root, dbConfig, method, pathname, req, res))) return;

		sendJson(res, 404, { error: `not found: ${method} ${pathname}` }, { cors });
	} catch (err) {
		sendError(res, err, { cors });
	}
}

// Default host 127.0.0.1 (loopback only) -- explicit --host opt-in required to expose beyond it,
// matching this project's established "safe default, explicit override" convention (e.g.
// --enforce-registry). Returns once the server has actually bound (server.address() is real), not
// merely once listen() was called -- callers (bin/bskel.mjs's cmdServe, tests) need the REAL bound
// port when 0 was requested. `dbConfig` (null by default) opts into the D-ddl-apply DB/patch-
// transaction routes -- see handleDbRoutes() above.
export function createHttpServer(root, { host = '127.0.0.1', port = 4747, dbConfig = null } = {}) {
	const server = http.createServer((req, res) => {
		handleRequest(root, req, res, dbConfig).catch((err) => sendError(res, err));
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
