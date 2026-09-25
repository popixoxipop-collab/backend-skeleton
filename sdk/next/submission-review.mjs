import { buildSupportMatrix, supportMatrixDiagnostics } from './support-matrix.mjs';
import { reviewAdapterPackage } from './package-inventory.mjs';

export const SUBMISSION_REVIEW_CONTRACT = 'sbf.adapter-submission-review/1';

function normalizeError(error) {
	return {
		code: 'BSKEL_SUBMISSION_INVALID',
		severity: 'blocked',
		status: 'conflict',
		message: `${error.source ?? 'submission'}${error.path ? ` ${error.path}` : ''}: ${error.message}`,
		evidenceRefs: [],
	};
}

export function reviewAdapterSubmission({
	manifest,
	inventory,
	explanations = [],
	observedPackageSha256 = null,
}) {
	const packageReview = reviewAdapterPackage({
		manifest,
		inventory,
		observedPackageSha256,
	});
	const diagnostics = packageReview.errors.map(normalizeError);
	let supportMatrix = null;
	let supportDiagnostics = [];
	let explanationError = null;

	if (!Array.isArray(explanations) || explanations.length === 0) {
		diagnostics.push({
			code: 'BSKEL_SUPPORT_EVIDENCE_MISSING',
			severity: 'warning',
			status: 'unknown',
			adapterId: manifest?.adapter?.id ?? null,
			message: 'no support explanations were supplied',
			evidenceRefs: [],
		});
	} else {
		try {
			supportMatrix = buildSupportMatrix(explanations);
			supportDiagnostics = supportMatrixDiagnostics(supportMatrix);
			diagnostics.push(...supportDiagnostics);
		} catch (error) {
			explanationError = String(error?.message ?? error);
			diagnostics.push({
				code: 'BSKEL_SUPPORT_EVIDENCE_INVALID',
				severity: 'blocked',
				status: 'conflict',
				adapterId: manifest?.adapter?.id ?? null,
				message: explanationError,
				evidenceRefs: [],
			});
		}
	}

	if (packageReview.missing.length > 0) {
		for (const missing of packageReview.missing) {
			diagnostics.push({
				code: 'BSKEL_PACKAGE_REFERENCE_MISSING',
				severity: 'blocked',
				status: 'conflict',
				adapterId: manifest?.adapter?.id ?? null,
				message: missing,
				evidenceRefs: [],
			});
		}
	}

	const hasSupportConflict = supportDiagnostics.some((item) => item.status === 'conflict');
	const supportEvidenceMissing = !Array.isArray(explanations) || explanations.length === 0;

	let status;
	if (packageReview.errors.length > 0 || packageReview.missing.length > 0 || explanationError) {
		status = 'needs-fixes';
	} else if (hasSupportConflict) {
		status = 'support-conflict';
	} else if (supportEvidenceMissing) {
		status = 'needs-support-evidence';
	} else {
		status = 'ready-for-execution-review';
	}

	return {
		contract: SUBMISSION_REVIEW_CONTRACT,
		adapterId: manifest?.adapter?.id ?? null,
		status,
		preExecutionReviewPassed: status === 'ready-for-execution-review',
		executable: false,
		requiresApproval: true,
		packageReview,
		supportMatrix,
		diagnostics,
		next: status === 'ready-for-execution-review'
			? [
				'verify package bytes/signature/revocation in the approved acquisition boundary',
				'run through the T20-approved isolated executor',
				'attach runtime evidence before any runtime-tested support claim',
			]
			: ['resolve blocked/missing/conflicting submission evidence, then rerun this review'],
		note: 'Pre-execution review is a structural/evidence readiness check only; it never authorizes adapter execution.',
	};
}
