// T24 integration discovery: keep nested Simulation/Robotics tests visible to the stable root test glob.
// This file imports tests only; it does not activate any runtime or registry surface.
import './sim-next/common/interface.test.mjs';
import './sim-next/mujoco/discover.test.mjs';
import './sim-next/mujoco/mjcf-source.test.mjs';
