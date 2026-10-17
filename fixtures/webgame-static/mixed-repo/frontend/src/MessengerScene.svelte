<script lang="ts">
  import { WebGLRenderer, Scene, MeshStandardMaterial } from 'three';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

  const renderer = new WebGLRenderer();
  const scene = new Scene();
  const material = new MeshStandardMaterial();
  const loader = new GLTFLoader();
  loader.load('/assets/avatar.glb');
  const worker = new Worker('/workers/pathfinding.js');
  const socket = new WebSocket('wss://example.invalid/game');

  function frame() {
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
</script>

<canvas></canvas>
