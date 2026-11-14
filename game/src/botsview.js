// Bot bodies: low-poly humanoids built from boxes, one group per bot, coloured by
// team. The sim owns where they are and whether they live; this only shows it —
// walking bob, a fall when they die, and a flash at the gun when they fire.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

function buildHumanoid(team) {
  const group = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: new THREE.Color(team === 'attack' ? PALETTE.friendly : PALETTE.enemy), roughness: 0.65, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.surface), roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: new THREE.Color('#c9a184'), roughness: 0.7 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.62, 0.3), suit);
  torso.position.y = 1.05;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), skin);
  head.position.y = 1.52;
  head.userData.part = 'head';
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.08, 0.05), dark);
  visor.position.set(0, 1.54, 0.14);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.22), dark);
  legL.position.set(-0.14, 0.36, 0);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.22), dark);
  legR.position.set(0.14, 0.36, 0);
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.14), suit);
  armL.position.set(-0.34, 1.05, 0.08);
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.14), suit);
  armR.position.set(0.34, 1.05, 0.08);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.62), dark);
  gun.position.set(0.2, 1.18, -0.28);
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.2, 0.2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sodium), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.2, 1.18, -0.62);
  group.add(torso, head, visor, legL, legR, armL, armR, gun, flash);
  group.traverse((mesh) => {
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  torso.userData.part = 'torso';
  return { group, torso, head, legL, legR, armL, armR, gun, flash };
}

export function createBotsView(scene, sim) {
  const views = new Map();
  const hitMeshes = [];

  for (const entity of sim.entities) {
    if (entity.isPlayer) continue;
    const view = buildHumanoid(entity.team);
    view.group.position.set(entity.pos.x, 0, entity.pos.z);
    scene.add(view.group);
    view.torso.userData.bot = entity;
    view.head.userData.bot = entity;
    hitMeshes.push(view.torso, view.head);
    views.set(entity.id, { ...view, entity, flashLeft: 0, lastTracerCount: 0 });
  }

  return {
    hitMeshes,
    step(dt) {
      for (const view of views.values()) {
        const entity = view.entity;
        view.group.position.set(entity.pos.x, entity.pos.y, entity.pos.z);
        view.group.rotation.y = entity.yaw;
        if (!entity.alive) {
          // Fall over and stay down until the next round.
          view.group.rotation.x = -entity.fall * 1.45;
          view.group.position.y = -entity.fall * 0.08;
          view.flash.material.opacity = 0;
          continue;
        }
        view.group.rotation.x = 0;
        const swing = Math.sin(entity.walkPhase) * 0.45;
        view.legL.rotation.x = swing;
        view.legR.rotation.x = -swing;
        view.armL.rotation.x = -swing * 0.6;
        view.armR.rotation.x = swing * 0.6;
        view.group.position.y = Math.abs(Math.sin(entity.walkPhase)) * 0.03;
        // Muzzle flash: a new tracer from this bot's gun means it just fired.
        const tracersFromHere = sim.fx.tracers.filter(
          (t) => Math.hypot(t.from.x - entity.pos.x, t.from.z - entity.pos.z) < 1,
        ).length;
        if (tracersFromHere > view.lastTracerCount) view.flashLeft = 0.06;
        view.lastTracerCount = tracersFromHere;
        view.flashLeft = Math.max(0, view.flashLeft - dt);
        view.flash.material.opacity = view.flashLeft > 0 ? 0.9 : 0;
        view.flash.rotation.z = view.flashLeft * 30;
      }
    },
    reset() {
      for (const view of views.values()) {
        view.group.rotation.set(0, 0, 0);
        view.group.position.y = 0;
        view.flashLeft = 0;
        view.lastTracerCount = 0;
      }
    },
  };
}
