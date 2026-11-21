import * as THREE from 'three';
import { WebGLRenderer as Renderer } from 'three';
const renderer = new Renderer();
const scene = new THREE.Scene();
renderer.render(scene, camera);
