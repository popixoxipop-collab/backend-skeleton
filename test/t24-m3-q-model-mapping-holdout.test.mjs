import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const HELPER=path.resolve(HERE,'../adapters/sim-next/mujoco/effective_model_helper.py');

test('Q-M3 mapping: reviewed transmissions map exactly and SO3 remains fail-closed', () => {
  const script=String.raw`
import importlib.util
import sys
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location("q_m3_helper",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class mjtTrn:
    mjTRN_JOINT=0
    mjTRN_JOINTINPARENT=1
    mjTRN_SLIDERCRANK=2
    mjTRN_TENDON=3
    mjTRN_SITE=4
    mjTRN_BODY=5
    mjTRN_SO3=6

mj=SimpleNamespace(mjtTrn=mjtTrn)
expected={
  0:"joint",1:"jointinparent",2:"slidercrank",
  3:"tendon",4:"site",5:"body",
}
for raw,want in expected.items():
  key=module._enum_suffix(mj,"mjtTrn","mjTRN_",raw)
  got=module.TRANSMISSION_ENUMS.get(key)
  if got != want:
    raise SystemExit(f"mapping mismatch {raw}: {got} != {want}")

so3=module._enum_suffix(mj,"mjtTrn","mjTRN_",6)
if module.TRANSMISSION_ENUMS.get(so3) is not None:
  raise SystemExit("SO3 unexpectedly reviewed")
`;
  const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER],{
    encoding:'utf8',
    timeout:10_000,
    maxBuffer:4*1024*1024,
    env:{},
  });
  assert.equal(child.status,0,child.stderr||child.stdout);
});

test('Q-M3 mapping: helper pins exactly MuJoCo 3.12.0', () => {
  const script=String.raw`
import importlib.util
import sys
spec=importlib.util.spec_from_file_location("q_m3_helper",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.SUPPORTED_MUJOCO_VERSION == "3.12.0"
`;
  const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER],{
    encoding:'utf8',
    timeout:10_000,
    maxBuffer:4*1024*1024,
    env:{},
  });
  assert.equal(child.status,0,child.stderr||child.stdout);
});
