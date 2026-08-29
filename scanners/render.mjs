// D-scanner-evidence: fixed presentation order (matches scanners/index.mjs's own SIGNAL_WEIGHTS
// declaration order) rather than whatever order evidence happens to appear in -- duplicated here
// as literal strings rather than imported, keeping this file a pure presentation layer over a
// plain report object (its existing convention; scanners/index.mjs never imports render.mjs
// either, no dependency direction to preserve either way).
const SIGNAL_ORDER = [
	'module_name', 'controller_class', 'controller_path',
	'endpoint_path', 'endpoint_operation_id',
	'entity_table', 'entity_class', 'enum_name',
];

// `bskel scan explain <module>` -- one module's full evidence breakdown, grouped by signal type,
// with a running weight subtotal per group so the sum visibly reconciles with `mod.score`.
export function renderScanExplain(mod) {
	const lines = [`# scan explain: \`${mod.module}\` (score: ${mod.score})`, ''];
	const bySignal = new Map();
	for (const e of mod.evidence ?? []) {
		if (!bySignal.has(e.signal)) bySignal.set(e.signal, []);
		bySignal.get(e.signal).push(e);
	}
	if (bySignal.size === 0) {
		lines.push('No evidence recorded -- this module scored 0.');
		lines.push('');
	}
	for (const signal of SIGNAL_ORDER) {
		const entries = bySignal.get(signal);
		if (!entries || entries.length === 0) continue;
		const subtotal = entries.reduce((sum, e) => sum + e.weight, 0);
		lines.push(`## ${signal} (weight ${entries[0].weight} each, subtotal ${subtotal})`);
		for (const e of entries) {
			const where = e.file ? ` (${e.file}${e.line ? `:${e.line}` : ''})` : '';
			lines.push(`- term \`${e.term}\` matched \`${e.value}\`${where}`);
		}
		lines.push('');
	}
	if ((mod.capped_signals ?? []).length > 0) {
		lines.push(`**Capped**: ${mod.capped_signals.join(', ')} had more raw matches than shown above -- score still reflects every entry listed, additional matches beyond the cap did not add further weight.`);
		lines.push('');
	}
	return `${lines.join('\n')}\n`;
}

export function renderScanMarkdown(report) {
	const lines = [];
	lines.push(`# Brownfield scan${report.feature_id ? `: ${report.feature_id}` : ''}`);
	lines.push('');
	lines.push(`**Terms**: ${report.terms.join(', ') || '(none)'}`);
	lines.push(`**Adapter**: ${report.adapter} (confidence: ${report.confidence})`);
	lines.push(`**API surface source**: ${report.api_surface_source}`);
	lines.push(`**Verdict**: \`${report.verdict}\``);
	lines.push('');

	if (report.related_modules.length === 0) {
		lines.push('No related modules found -- greenfield for these terms.');
	} else {
		lines.push('## Related modules');
		lines.push('');
		for (const mod of report.related_modules) {
			lines.push(`### \`${mod.module}\` (score: ${mod.score} -- run \`bskel scan explain ${mod.module}\` for the evidence breakdown)`);
			for (const c of mod.controllers) {
				lines.push(`- Controller \`${c.className}\` (base path \`${c.basePath}\`), ${c.endpoints.length} endpoint(s):`);
				for (const ep of c.endpoints) {
					lines.push(`  - \`${ep.verb} ${ep.path}\` -- operationId \`${ep.operationId ?? '(unmatched)'}\` (\`${ep.method}\`)`);
				}
			}
			for (const e of mod.entities) {
				lines.push(`- Entity \`${e.className}\` -> table \`${e.table ?? '(unknown)'}\`, PK field \`${e.idField ?? '(unknown)'}\``);
			}
			for (const en of mod.enums) {
				lines.push(`- Enum \`${en.name}\`: ${en.constants.join(', ')}`);
			}
			if (mod.dtos.length > 0) {
				lines.push(`- DTOs: ${mod.dtos.map((d) => d.className).join(', ')}`);
			}
			lines.push('');
		}
	}

	// A4 (D-db-schema-plane): only present when --db was passed -- drift findings already land in
	// `unknowns` (rendered above/below depending on source order), this section is just the raw
	// table/column inventory for a human skimming the markdown without --json.
	if (report.db_schema) {
		lines.push('## Database schema (Plane A/C)');
		const { migrations, live } = report.db_schema;
		lines.push(`- Migrations: ${migrations.tool === 'none' ? 'none found' : `${migrations.tool}, ${migrations.files.length} file(s), ${migrations.tables.length} table reference(s)`}`);
		if (live) {
			lines.push(`- Live schema \`${live.schema}\`: ${live.tables.length} table(s), hash \`${live.schema_hash.slice(0, 12)}\``);
			for (const t of live.tables) lines.push(`  - \`${t.name}\` (${t.columns.length} column(s))`);
		} else {
			lines.push('- Live schema: not introspected (pass --database-url-env for Plane C)');
		}
		lines.push('');
	}

	if (report.unknowns.length > 0) {
		lines.push('## Unknowns');
		for (const u of report.unknowns) lines.push(`- ${u}`);
		lines.push('');
	}

	if (report.disposition) {
		lines.push('## Disposition');
		lines.push('');
		lines.push(`**Mode**: \`${report.disposition.mode}\` (recorded ${report.disposition.at})`);
		lines.push('');
		lines.push(report.disposition.note || '(no note provided)');
		lines.push('');
	}

	return `${lines.join('\n')}\n`;
}

export function renderPlanConstraints(report) {
	if (!report.disposition) return null;
	const { mode, note } = report.disposition;
	const lines = [`# Plan constraints (from brownfield-scan disposition: ${mode})`, ''];

	const modeInstructions = {
		reuse: 'Plan MUST NOT create new entities/controllers/endpoints for the modules listed below. Restrict scope to regression tests and documentation corrections only.',
		extend: 'Plan may ADD to the modules listed below, but every new field/endpoint must state why the existing one is insufficient. Do not duplicate existing functionality.',
		replace: 'Plan replaces functionality in the modules listed below. Requires --breaking-approved to have been passed to `scan disposition`. Must include an explicit deprecation section for what is being replaced.',
		parallel: 'Plan introduces a new, separately-named module alongside the ones listed below. Re-run `bskel scan` against the new module name before implementing to confirm no further collision.',
	};
	lines.push(modeInstructions[mode] ?? '');
	lines.push('');
	if (note) {
		lines.push('## Human note');
		lines.push(note);
		lines.push('');
	}
	lines.push('## Existing modules this disposition applies to');
	for (const mod of report.related_modules) {
		lines.push(`- \`${mod.module}\` (score ${mod.score}) -- see brownfield-scan.md for full detail`);
	}
	return `${lines.join('\n')}\n`;
}
