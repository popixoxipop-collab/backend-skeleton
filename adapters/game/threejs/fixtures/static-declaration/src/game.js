import * as THREE from 'three';

const scene = new THREE.Scene();
const actor = new THREE.Mesh();
const renderer = new THREE.WebGLRenderer();
scene.add(actor);

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

loader.load('/assets/direct.glb');
animate();
