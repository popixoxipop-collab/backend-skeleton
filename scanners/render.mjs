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
			lines.push(`### \`${mod.module}\` (score: ${mod.score})`);
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
				lines.push(`- DTOs: ${mod.dtos.join(', ')}`);
			}
			lines.push('');
		}
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
