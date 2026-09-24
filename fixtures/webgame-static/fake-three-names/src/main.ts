import { Vector3 } from 'three';
class WebGLRenderer { render() {} }
class Scene {}
const renderer = new WebGLRenderer();
const scene = new Scene();
renderer.render(scene, camera);
const point = new Vector3();
