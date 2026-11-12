#!/usr/bin/env node
// Explicit opt-in T20 product scan CLI. The stable bskel CLI is unchanged.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runGatedProductScan } from './gated-product-scan.mjs';

const CLI_SCHEMA = 'bskel.gated-product-scan-cli/1';
const MAX_ARG = 1024 * 1024;
function usage() {
  throw new Error('usage: node lib/trust-next/gated-product-scan-cli.mjs --repo ABS_PATH --policy-json JSON --files-json JSON [--terms-json JSON]');
}
export async function runCli(args) {
  const choices = new Set(['--repo','--policy-json','--files-json','--terms-json']);
  const parsed = {};
  for (let i=0; i<args.length; i+=2) {
    const key=args[i], val=args[i+1];
    if (!choices.has(key) || Object.hasOwn(parsed,key) ||
        typeof val!=='string' || val.length > MAX_ARG) usage();
    parsed[key]=val;
  }
  if (args.length%2!==0 || !parsed['--repo'] ||
      !parsed['--files-json'] || !parsed['--policy-json']) usage();
  if (!path.isAbsolute(parsed['--repo'])) usage();
  const files=JSON.parse(parsed['--files-json']);
  const manifest=JSON.parse(parsed['--policy-json']);
  const terms=parsed['--terms-json'] ? JSON.parse(parsed['--terms-json']) : [];
  return runGatedProductScan({repoRoot:parsed['--repo'],manifest,files,terms});
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(result=>{
    console.log(JSON.stringify(result));
  }).catch(error=>{
    console.error(JSON.stringify({schema:CLI_SCHEMA,error_code:error.code??'GATED_SCAN_FAILED',
      message:String(error.message).slice(0,500)}));
    process.exitCode=2;
  });
}
