// T24 M4A bridge: keep native dependency resolver tests visible to the root CI glob.
// Import only; this does not execute MuJoCo, the M3 helper, MJCF, or MjModel.
import './sim-next/mujoco/native-dependency-resolver.test.mjs';
