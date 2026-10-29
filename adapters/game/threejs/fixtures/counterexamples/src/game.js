import * as THREE from 'three';

const scene = new THREE.Scene();
const actor = new THREE.Mesh();
scene.add(actor);
scene.remove(actor);
actor.geometry.dispose();

const assetUri = `/assets/${name}.gltf`;
loader.load(assetUri);

function animate() {
  requestAnimationFrame(animate);
}
animate();
