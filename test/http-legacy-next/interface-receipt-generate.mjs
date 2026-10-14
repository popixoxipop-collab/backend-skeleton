import { generate, RECEIPT_FILE } from './interface-receipt-lib.mjs';

// Writes adapters/http-legacy-next/INTERFACE_RECEIPT.json for the commit that is checked out. Run it from the repository root on a clean tree, then commit
// the file it wrote on its own:
//   node test/http-legacy-next/interface-receipt-generate.mjs
// It runs both recorded commands itself and exits 1 without writing when the tree is not clean, a command does not pass or a command edits the tree.
// All of the work is in interface-receipt-lib.mjs, where the receipt test exercises it.
try {
  const { receipt, revision, tree } = await generate();
  console.log(`wrote ${RECEIPT_FILE} for revision ${revision} (tree ${tree}, node ${receipt.node_version})`);
  for (const c of receipt.commands) console.log(`${c.id}: exit ${c.exit_code}, tests ${c.tests}, pass ${c.pass}, fail ${c.fail}, skipped ${c.skipped}`);
  console.log(`receipt_digest ${receipt.receipt_digest}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
