import test from 'node:test';

if(process.platform==='linux'){
  await import('./sim-next/mujoco/native-dependency-resolver.test.mjs');
}else{
  test('T24 M4A native resolver suite is Linux-only',{skip:'requires Linux x86_64 Python 3.12 native roots'},()=>{});
}
