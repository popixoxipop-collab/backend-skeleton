export function evaluateWebgameExecutionApproval(contract, approval = null) {
  if (!contract || contract.schema !== 'sbf.webgame-runtime/1') throw new Error('execution approval requires a normalized webgame runtime contract');
  const blockedBy = [];
  if (contract.source.trust === 'reference') blockedBy.push('source.trust');
  if (!approval || approval.allow_execute !== true) {
    blockedBy.push('execution.approval');
  } else {
    if (approval.project_id !== contract.project_id) blockedBy.push('execution.approval.project_id');
    if (approval.source_root !== contract.source.root) blockedBy.push('execution.approval.source_root');
  }
  return {
    approved: blockedBy.length === 0,
    blocked_by: [...new Set(blockedBy)],
    approval_id: approval?.approval_id ?? null,
  };
}
