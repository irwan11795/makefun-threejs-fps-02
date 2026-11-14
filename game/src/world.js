// Kestrel Yard, built from map.js: every box in the data becomes a mesh and a
// collider, so the seen map and the simulated map are the same map. Plain
// geometry only, no models and no textures loaded from anywhere — the ground
// markings and the site letters are drawn on canvases at runtime.
import * as THREE from 'three';
import { MAP } from './map.js';
import { PALETTE } from './palette.js';

function groundTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#33383f';
  ctx.fillRect(0, 0, 512, 512);
  // Asphalt noise.
  for (let i = 0; i < 9000; i += 1) {
    const shade = 40 + Math.floor(Math.random() * 26);
    ctx.fillStyle = `rgb(${shade},${shade + 3},${shade + 6})`;
    ctx.fillRect(Math.floor(Math.random() * 512), Math.floor(Math.random() * 512), 2, 2);
  }
  // Faded yard lines.
  ctx.strokeStyle = 'rgba(236, 231, 219, 0.16)';
  ctx.lineWidth = 3;
  ctx.setLineDash([26, 18]);
  ctx.beginPath();
  ctx.moveTo(256, 0);
  ctx.lineTo(256, 512);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 256);
  ctx.lineTo(512, 256);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(6, 5);
  texture.anisotropy = 4;
  return texture;
}

function letterTexture(letter, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = color;
  ctx.font = 'bold 84px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 64, 70);
  return new THREE.CanvasTexture(canvas);
}

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of ['surface', 'concrete', 'rust', 'teal', 'ink', 'sodium']) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'ink' || name === 'sodium' ? 0.55 : 0.9,
      metalness: name === 'rust' || name === 'teal' ? 0.25 : 0.03,
    });
  }

  const colliders = [];
  const shootables = [];

  function classify(box) {
    const height = box.y1 - box.y0;
    const width = box.x1 - box.x0;
    const depth = box.z1 - box.z0;
    if (height >= 5) return 'surface'; // outer walls
    if (height >= 2.6 && width >= 4) return box.x0 < 0 ? 'teal' : 'rust'; // site blocks + mid container
    if (height >= 2.6) return 'rust'; // lane walls read as rust steel
    return 'concrete'; // crates and the low platform
  }

  function box(data) {
    const width = data.x1 - data.x0;
    const height = data.y1 - data.y0;
    const depth = data.z1 - data.z0;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), materials[classify(data)]);
    mesh.position.set((data.x0 + data.x1) / 2, (data.y0 + data.y1) / 2, (data.z0 + data.z1) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    return mesh;
  }

  // Ground.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(44.8, 32.8),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  for (const data of MAP.colliders) box(data);

  // Bomb sites: a glowing ring on the ground and a floating letter.
  const siteMarkers = {};
  for (const key of ['A', 'B']) {
    const site = MAP.sites[key];
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.radius - 0.25, site.radius, 48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sodium), transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.center.x, 0.03, site.center.z);
    group.add(ring);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(site.radius, 48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sodium), transparent: true, opacity: 0.08, side: THREE.DoubleSide }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(site.center.x, 0.02, site.center.z);
    group.add(disc);
    const letter = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 2.2),
      new THREE.MeshBasicMaterial({ map: letterTexture(key, PALETTE.sodium), transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    letter.position.set(site.center.x, 3.4, site.center.z);
    group.add(letter);
    siteMarkers[key] = { ring, disc, letter };
  }

  // Sodium lamp posts: pole, glowing head, and one real light each.
  const lampLights = [];
  const lampSpots = [
    [-10, -10],
    [10, -10],
    [-10, 10],
    [10, 10],
  ];
  for (const [x, z] of lampSpots) {
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.18, 4.4, 0.18), materials.concrete);
    pole.position.set(x, 2.2, z);
    pole.castShadow = true;
    group.add(pole);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.18, 0.3),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sodium) }),
    );
    head.position.set(x, 4.45, z);
    group.add(head);
    const light = new THREE.PointLight(new THREE.Color(PALETTE.sodium), 14, 16, 1.8);
    light.position.set(x, 4.2, z);
    scene.add(light);
    lampLights.push(light);
  }

  // Light: a low dusk sun from the west, a cool sky fill, and the yard lamps.
  const sky = new THREE.HemisphereLight(new THREE.Color('#5a6b7d'), new THREE.Color('#1c1f24'), 0.9);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(new THREE.Color('#ffb37a'), 1.6);
  sun.position.set(-18, 16, 10);
  sun.target.position.set(0, 0, -2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -26;
  sun.shadow.camera.right = 26;
  sun.shadow.camera.top = 22;
  sun.shadow.camera.bottom = -22;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  return { colliders, shootables, group, siteMarkers, lampLights };
}
