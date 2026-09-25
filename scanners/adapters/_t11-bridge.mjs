import { LEGACY_HTTP_ADAPTER_IDS } from './_t11-baselines.mjs';

// T11-02 compatibility shim.
//
// This wrapper is intentionally lossless and semantically boring: it carries the exact legacy
// sbf.scan-report/2 JSON shape plus an immutable descriptor snapshot. It does NOT invent the
// T01/T02/T03 "next" IR ahead of those tracks and does not rename/normalize route, entity,
// capability, or identity fields. T11-03 can project from this bridge only after the shared next
// interface is frozen.
//
// The leading "_" keeps this module outside scanners/registry.mjs auto-discovery, so legacy
// adapter arbitration and scan bytes cannot change merely because this file exists.
export const LEGACY_HTTP_BRIDGE_SCHEMA = 'sbf.http-legacy-bridge/1';

function jsonClone(value) {
	return JSON.parse(JSON.stringify(value));
}

function requireLegacyAdapter(adapter) {
	if (!adapter || typeof adapter !== 'object') {
		throw new TypeError('legacy HTTP bridge requires an adapter descriptor object');
	}
	if (!LEGACY_HTTP_ADAPTER_IDS.includes(adapter.id)) {
		throw new Error(`adapter "${adapter.id ?? '(missing)'}" is not one of T11's five legacy HTTP adapters`);
	}
	if (adapter.contract !== 'sbf.adapter/2') {
		throw new Error(`adapter "${adapter.id}" must still declare sbf.adapter/2 before it can enter the T11 compatibility bridge`);
	}
	return adapter;
}

export function snapshotLegacyHttpAdapter(adapter) {
	const source = requireLegacyAdapter(adapter);
	return {
		contract: source.contract,
		id: source.id,
		title: source.title,
		specificity: source.specificity,
		confidence: source.confidence,
		verificationBasis: source.verificationBasis,
		capabilities: jsonClone(source.capabilities),
	};
}

export function summarizeLegacyHttpReport(report) {
	if (!report || typeof report !== 'object' || report.schema !== 'sbf.scan-report/2') {
		throw new Error('T11 compatibility bridge only accepts sbf.scan-report/2 reports');
	}
	const modules = report.related_modules ?? [];
	return {
		modules: modules.map((m) => m.module),
		moduleCount: modules.length,
		controllerCount: modules.reduce((n, m) => n + (m.controllers?.length ?? 0), 0),
		entityCount: modules.reduce((n, m) => n + (m.entities?.length ?? 0), 0),
		enumCount: modules.reduce((n, m) => n + (m.enums?.length ?? 0), 0),
		dtoCount: modules.reduce((n, m) => n + (m.dtos?.length ?? 0), 0),
		endpointCount: modules.reduce(
			(n, m) => n + (m.controllers ?? []).reduce((k, c) => k + (c.endpoints?.length ?? 0), 0),
			0,
		),
		filesReadCount: report.files_read?.length ?? 0,
	};
}

export function bridgeLegacyHttpScan({ adapter, report }) {
	const descriptor = snapshotLegacyHttpAdapter(adapter);
	if (!report || report.schema !== 'sbf.scan-report/2') {
		throw new Error('T11 compatibility bridge only accepts sbf.scan-report/2 reports');
	}
	if (report.adapter !== descriptor.id) {
		throw new Error(`scan report adapter "${report.adapter ?? '(missing)'}" does not match descriptor "${descriptor.id}"`);
	}
	return {
		schema: LEGACY_HTTP_BRIDGE_SCHEMA,
		mode: 'compatibility-only',
		source_adapter: descriptor,
		source_scan_schema: report.schema,
		legacy_report: jsonClone(report),
	};
}
