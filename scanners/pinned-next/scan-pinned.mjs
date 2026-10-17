import crypto from 'node:crypto';
import { requireVerifiedSnapshot } from './git-snapshot.mjs';
import { makeSnapshotFs } from './virtual-fs.mjs';
import { createNextScanner, ORIGINAL_T13_NEXT_SOURCE_SHA256 } from './next-static-factory.mjs';

const hash = x => crypto.createHash('sha256').update(x).digest('hex');

// Untrusted caller-supplied snapshot objects are NOT accepted; an input must
// have passed the exact Git-object verifier in this process. Only the verified
// and SHA-bound static parser body is used. No source code text rewriting,
// dynamic import, eval, global capture or target application execution.
export function scanPinnedNext({ snapshot, onBeforeVirtualOpen } = {}) {
  requireVerifiedSnapshot(snapshot);
  const io = makeSnapshotFs(snapshot, { onBeforeVirtualOpen });
  const { detectNextRoot, scanNext } = createNextScanner(io);
  const detection = detectNextRoot(io.root);
  const report = scanNext(io.root, detection);
  const virtualIo = io.operationCount();
  if (virtualIo.unclosed !== 0) throw Error('VIRTUAL_FD_LEAK');
  const report_sha256 = hash(Buffer.from(JSON.stringify(report), 'utf8'));
  const result_sha256 = hash(Buffer.from(JSON.stringify({
    source_commit: snapshot.git_commit,
    source_tree: snapshot.git_tree,
    source_snapshot_sha256: snapshot.snapshot_sha256,
    trusted_scanner_sha256: ORIGINAL_T13_NEXT_SOURCE_SHA256,
    report_sha256,
  }), 'utf8'));
  return Object.freeze({
    report_sha256,
    result_sha256,
    source_commit: snapshot.git_commit,
    source_tree: snapshot.git_tree,
    source_snapshot_sha256: snapshot.snapshot_sha256,
    trusted_scanner_sha256: ORIGINAL_T13_NEXT_SOURCE_SHA256,
    detection,
    report,
    virtual_io: virtualIo,
    security_scope: 'TRUSTED_PINNED_GIT_OBJECTS_NOT_MUTABLE_WORKTREE',
  });
}
