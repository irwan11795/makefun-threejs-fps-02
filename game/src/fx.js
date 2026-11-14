// Transient effects, driven by the sim's fx queues: tracers from every shot,
// hit bursts where a bullet lands, and explosions. One pool per effect, reused
// every frame — nothing is allocated in the hot loop.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const MAX_TRACERS = 24;
const MAX_BURSTS = 16;
const MAX_BOOMS = 4;

export function createFx(scene) {
  const tracers = [];
  for (let i = 0; i < MAX_TRACERS; i += 1) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.sodium), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, ttl: 0 });
  }

  const bursts = [];
  for (let i = 0; i < MAX_BURSTS; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.enemy), transparent: true, opacity: 0, depthWrite: false }),
    );
    mesh.visible = false;
    scene.add(mesh);
    bursts.push({ mesh, ttl: 0 });
  }

  const booms = [];
  for (let i = 0; i < MAX_BOOMS; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sodium), transparent: true, opacity: 0, depthWrite: false }),
    );
    mesh.visible = false;
    scene.add(mesh);
    const light = new THREE.PointLight(new THREE.Color(PALETTE.sodium), 0, 18, 1.6);
    scene.add(light);
    booms.push({ mesh, light, ttl: 0, big: false });
  }

  let tracerCursor = 0;
  let burstCursor = 0;
  let boomCursor = 0;

  return {
    tracer(from, to) {
      const slot = tracers[tracerCursor];
      tracerCursor = (tracerCursor + 1) % MAX_TRACERS;
      const positions = slot.line.geometry.attributes.position.array;
      positions[0] = from.x;
      positions[1] = from.y;
      positions[2] = from.z;
      positions[3] = to.x;
      positions[4] = to.y;
      positions[5] = to.z;
      slot.line.geometry.attributes.position.needsUpdate = true;
      slot.ttl = 0.08;
      slot.line.material.opacity = 0.9;
    },
    burst(pos, headshot) {
      const slot = bursts[burstCursor];
      burstCursor = (burstCursor + 1) % MAX_BURSTS;
      slot.mesh.position.set(pos.x, pos.y, pos.z);
      slot.mesh.material.color.set(new THREE.Color(headshot ? PALETTE.sodium : PALETTE.enemy));
      slot.mesh.visible = true;
      slot.ttl = 0.25;
    },
    boom(pos, big) {
      const slot = booms[boomCursor];
      boomCursor = (boomCursor + 1) % MAX_BOOMS;
      slot.mesh.position.set(pos.x, Math.max(0.4, pos.y), pos.z);
      slot.light.position.set(pos.x, pos.y + 1, pos.z);
      slot.mesh.visible = true;
      slot.ttl = big ? 1.2 : 0.9;
      slot.big = big;
    },
    step(dt) {
      for (const slot of tracers) {
        if (slot.ttl <= 0) continue;
        slot.ttl -= dt;
        slot.line.material.opacity = Math.max(0, slot.ttl / 0.08) * 0.9;
      }
      for (const slot of bursts) {
        if (slot.ttl <= 0) continue;
        slot.ttl -= dt;
        const scale = 1 + (0.25 - slot.ttl) * 6;
        slot.mesh.scale.setScalar(scale);
        slot.mesh.material.opacity = Math.max(0, slot.ttl / 0.25);
        if (slot.ttl <= 0) slot.mesh.visible = false;
      }
      for (const slot of booms) {
        if (slot.ttl <= 0) continue;
        slot.ttl -= dt;
        const life = slot.big ? 1.2 : 0.9;
        const done = 1 - Math.max(0, slot.ttl / life);
        slot.mesh.scale.setScalar(0.4 + done * (slot.big ? 7 : 4.5));
        slot.mesh.material.opacity = Math.max(0, (1 - done) * 0.75);
        slot.light.intensity = Math.max(0, (1 - done) * (slot.big ? 60 : 30));
        if (slot.ttl <= 0) {
          slot.mesh.visible = false;
          slot.light.intensity = 0;
        }
      }
    },
  };
}
