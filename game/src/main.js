// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the
// display's rate. The sim owns the game; this file owns the camera, the raycast
// for the player's shots, and the DOM. ?shot=start|play|plant|end with &seed=N
// sets up a deterministic frame for a capture, renders it twice, then freezes
// it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { MAP } from './map.js';
import { WEAPONS, GRENADE, spreadFor, damageFor } from './weapons.js';
import { createSim, FIXED_STEP } from './sim.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { look, recoil, groundSpeed } from './player.js';
import { createWeaponView } from './weapon.js';
import { createBotsView } from './botsview.js';
import { createFx } from './fx.js';
import { createHud } from './hud.js';

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

const sim = createSim(seed);
const random = sim.random;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
// preserveDrawingBuffer costs a little speed and changes nothing visually,
// but it keeps the frame readable after the compositor runs — the shot export
// (toDataURL / toBlob) must never see a cleared buffer.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.sky), 24, 70);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const world = createWorld(scene);
const fx = createFx(scene);
const botsView = createBotsView(scene, sim);
const weaponView = createWeaponView(camera);
const hud = createHud();
const input = createInput(renderer.domElement, onLockChange);
const raycaster = new THREE.Raycaster();
raycaster.far = 90;
const shootables = world.shootables.concat(botsView.hitMeshes);

// Reused temporaries: nothing is allocated in the hot loop.
const direction = new THREE.Vector3();
const muzzle = new THREE.Vector3();
const endPoint = new THREE.Vector3();
const tmpVec = new THREE.Vector3();

// Grenade meshes, one per live grenade.
const grenadeMeshes = [];
for (let i = 0; i < 2; i += 1) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 8),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.surface), roughness: 0.6 }),
  );
  mesh.visible = false;
  scene.add(mesh);
  grenadeMeshes.push(mesh);
}

// The planted bomb: a blinking box the defenders converge on.
const bombMesh = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 0.25, 0.3),
  new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.surface), emissive: new THREE.Color(PALETTE.sodium), emissiveIntensity: 0.4, roughness: 0.6 }),
);
bombMesh.visible = false;
bombMesh.castShadow = true;
scene.add(bombMesh);

const player = sim.player;
let bloom = 0;
let started = false;
let frozen = false;
let buyOpen = false;
let grenadeShowLeft = 0;
let shakeLeft = 0;
let lastHp = player.hp;
let prevPhase = sim.phase;
let seenEvents = 0;
let seenTracers = 0;
let seenHits = 0;
let seenBooms = 0;
let wasFiring = false;
let downShown = false;
let accumulator = 0;
let lastTime = performance.now();

function syncCamera() {
  camera.position.set(player.pos.x, player.pos.y + player.eye, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  if (shakeLeft > 0) {
    camera.rotation.x += (random() - 0.5) * 0.02 * shakeLeft;
    camera.rotation.y += (random() - 0.5) * 0.02 * shakeLeft;
  }
}

function startReload() {
  const def = WEAPONS[player.weapon];
  const ammo = player.ammo[player.weapon];
  if (player.reloadLeft > 0 || ammo.mag >= def.mag || ammo.reserve <= 0) return;
  player.reloadLeft = def.reload;
}

function owned(weaponId) {
  if (weaponId === 'pistol') return true;
  const ammo = player.ammo[weaponId];
  return ammo.mag + ammo.reserve > 0;
}

function switchWeapon(weaponId) {
  if (!owned(weaponId) || player.weapon === weaponId) return;
  player.weapon = weaponId;
  player.reloadLeft = 0;
  weaponView.show(weaponId);
  refreshAmmoHud();
}

function refreshAmmoHud() {
  const ammo = player.ammo[player.weapon];
  hud.setAmmo(ammo.mag, ammo.reserve, WEAPONS[player.weapon].name, player.grenades);
}

function toggleBuy() {
  if (sim.phase !== 'buy') return;
  buyOpen = !buyOpen;
  if (buyOpen) {
    if (document.pointerLockElement) document.exitPointerLock();
    hud.setBuy(true, sim.money, ownedWeapons());
  } else {
    hud.setBuy(false, sim.money, ownedWeapons());
    if (started && !shot) input.requestLock();
  }
}

function ownedWeapons() {
  const list = ['pistol'];
  if (owned('rifle')) list.push('rifle');
  if (owned('smg')) list.push('smg');
  if (player.grenades > 0) list.push('grenade');
  if (player.armor > 0) list.push('armor');
  return list;
}

function shoot() {
  const def = WEAPONS[player.weapon];
  const ammo = player.ammo[player.weapon];
  if (ammo.mag <= 0) {
    startReload();
    return;
  }
  if (player.cooldown > 0 || player.reloadLeft > 0) return;
  ammo.mag -= 1;
  player.cooldown = def.gap;
  bloom = Math.min(0.03, bloom + 0.004);
  camera.getWorldDirection(direction);
  const spread = spreadFor(def, groundSpeed(player), 5.2, bloom);
  direction.x += (random() * 2 - 1) * spread;
  direction.y += (random() * 2 - 1) * spread;
  direction.z += (random() * 2 - 1) * spread;
  direction.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, direction);
  const hit = raycaster.intersectObjects(shootables, false)[0];
  muzzle.set(0.24, -0.18, -0.95);
  camera.localToWorld(muzzle);
  if (hit) {
    endPoint.copy(hit.point);
    const bot = hit.object.userData.bot;
    if (bot && bot.alive) {
      const head = hit.object.userData.part === 'head';
      const killed = sim.damageEntity(bot, damageFor(def, head), player, head);
      hud.hitMarker(killed, 90);
      fx.burst(hit.point, head);
    } else {
      fx.burst(hit.point, false);
    }
  } else {
    endPoint.copy(camera.position).addScaledVector(direction, 80);
  }
  fx.tracer(muzzle, endPoint);
  sim.shots.push({ pos: { x: player.pos.x, y: player.pos.y, z: player.pos.z }, team: 'attack', at: sim.now });
  weaponView.fire();
  recoil(player, def.kick + random() * 0.002, (random() * 2 - 1) * 0.004);
  refreshAmmoHud();
}

function consumeQueue() {
  for (const action of input.takeQueue()) {
    if (action.type === 'buy') toggleBuy();
    else if (action.type === 'grenade') {
      if (buyOpen) {
        if (sim.buy('armor')) refreshAmmoHud();
      } else if (sim.throwGrenade()) {
        weaponView.show('grenade');
        grenadeShowLeft = 0.6;
        refreshAmmoHud();
      }
    } else if (action.type === 'weapon') {
      if (buyOpen) {
        const buyId = { pistol: 'rifle', rifle: 'smg', smg: 'grenade' }[action.weapon];
        if (buyId && sim.buy(buyId)) {
          refreshAmmoHud();
          hud.setBuy(true, sim.money, ownedWeapons());
        }
      } else {
        switchWeapon(action.weapon);
      }
    }
  }
  if (input.state.keys.has('KeyR')) startReload();
}

function pushHud() {
  hud.setHealth(player.hp, player.armor);
  hud.setMoney(sim.money);
  hud.setScore(sim.match.attack, sim.match.defend, sim.round);
  hud.setSpread(spreadFor(WEAPONS[player.weapon], groundSpeed(player), 5.2, bloom));
  if (sim.phase === 'planted') hud.setTimer(sim.bomb.fuse, 'planted');
  else hud.setTimer(sim.timer, sim.phase);
  hud.setBomb(sim.bomb.state, sim.bomb.fuse, sim.bomb.site ? MAP.sites[sim.bomb.site].name : '');
  hud.setPlant(sim.bomb.state === 'carried' ? sim.bomb.plantProgress / 3 : 0);
  hud.setFeed(sim.feed);
  if (player.hp < lastHp) hud.damageFlash();
  lastHp = player.hp;
  // Drain the sim's fx queues into the render pools, once per entry.
  for (const entry of sim.fx.tracers) {
    if (entry.__shown) continue;
    entry.__shown = true;
    fx.tracer(entry.from, entry.to);
  }
  for (const entry of sim.fx.hits) {
    if (entry.__shown) continue;
    entry.__shown = true;
    fx.burst(entry.pos, entry.headshot);
  }
  for (const entry of sim.fx.explosions) {
    if (entry.__shown) continue;
    entry.__shown = true;
    fx.boom(entry.pos, entry.big);
    shakeLeft = entry.big ? 1 : 0.5;
  }
  // New round events become banners.
  while (seenEvents < sim.roundEvents.length) {
    const event = sim.roundEvents[seenEvents];
    seenEvents += 1;
    if (event.type === 'planted') hud.showBanner('planted', `Bomb planted at ${MAP.sites[event.site].name}`);
    else if (event.type === 'defused') hud.showBanner('roundLoss', `Bomb defused by ${event.by}`);
  }
  // Phase transitions become banners and overlays.
  if (sim.phase !== prevPhase) {
    if (sim.phase === 'buy') downShown = false;
    if (sim.phase === 'over') {
      if (sim.matchOver) {
        hud.showOverlay(sim.matchWinner === 'attack' ? 'matchWin' : 'matchLoss');
        if (document.pointerLockElement) document.exitPointerLock();
      } else {
        hud.showBanner(sim.roundWinner === 'attack' ? 'roundWin' : 'roundLoss');
      }
    } else if (sim.phase === 'buy') {
      hud.hideBanner();
      botsView.reset();
      refreshAmmoHud();
    }
    prevPhase = sim.phase;
  }
  // The player going down gets one notice; the team fights on.
  if (!player.alive && (sim.phase === 'live' || sim.phase === 'planted') && !downShown) {
    downShown = true;
    hud.showBanner('down');
  }
  // Grenade meshes follow live grenades; the bomb blinks while planted.
  sim.grenades.forEach((g, i) => {
    grenadeMeshes[i].visible = true;
    grenadeMeshes[i].position.set(g.pos.x, g.pos.y, g.pos.z);
  });
  for (let i = sim.grenades.length; i < grenadeMeshes.length; i += 1) grenadeMeshes[i].visible = false;
  if (sim.bomb.state === 'planted') {
    bombMesh.visible = true;
    bombMesh.position.set(sim.bomb.pos.x, 0.15, sim.bomb.pos.z);
    bombMesh.material.emissiveIntensity = 0.4 + 0.6 * Math.abs(Math.sin(sim.now * 5));
    const marker = world.siteMarkers[sim.bomb.site];
    if (marker) marker.ring.material.opacity = 0.5 + 0.4 * Math.abs(Math.sin(sim.now * 5));
  } else {
    bombMesh.visible = false;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (frozen) {
    renderer.render(scene, camera);
    return;
  }
  const lookDelta = input.takeLook();
  look(player, lookDelta.x, lookDelta.y);
  consumeQueue();
  const firing = input.state.firing && player.alive && (sim.phase === 'live' || sim.phase === 'planted');
  if (firing) {
    const def = WEAPONS[player.weapon];
    if (def.auto || !wasFiring) shoot();
  }
  wasFiring = input.state.firing;
  bloom = Math.max(0, bloom - dt * 0.02);
  shakeLeft = Math.max(0, shakeLeft - dt * 1.5);
  grenadeShowLeft = Math.max(0, grenadeShowLeft - dt);
  if (grenadeShowLeft === 0 && player.weapon !== 'grenade') weaponView.show(player.weapon);

  const simInput = {
    keys: input.state.keys,
    firing: input.state.firing,
    plant: input.state.keys.has('KeyE'),
  };
  accumulator += dt;
  let steps = 0;
  while (accumulator >= FIXED_STEP && steps < 5) {
    sim.step(FIXED_STEP, simInput);
    accumulator -= FIXED_STEP;
    steps += 1;
  }
  if (accumulator > FIXED_STEP * 5) accumulator = 0;

  weaponView.setReload(player.reloadLeft > 0 ? player.reloadLeft / WEAPONS[player.weapon].reload : 0);
  weaponView.step(dt);
  botsView.step(dt);
  fx.step(dt);
  syncCamera();
  pushHud();
  renderer.render(scene, camera);
}

function settle(steps) {
  const idle = { keys: new Set(), firing: false, plant: false };
  for (let i = 0; i < steps; i += 1) sim.step(FIXED_STEP, idle);
}

function aimAt(point) {
  const dx = point.x - player.pos.x;
  const dy = point.y - (player.pos.y + player.eye);
  const dz = point.z - player.pos.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted >= 2) {
      // No third frame: the staged frame is exported now, then frozen.
      exportShotFrame();
      return;
    }
    requestAnimationFrame(paint);
  }
  requestAnimationFrame(paint);
}

// Shot export: the staged frame as a real render of the game's own code, at
// exactly 1280x800, downloaded as a PNG file. The capturing browser's window
// is fixed at 1919x998 and cannot be resized, and it has no download link to
// save a viewport screenshot from — so the page exports the file itself.
//
// What is exported is the whole page as the browser renders it: the 3D frame
// (captured from the WebGL canvas right after the render above) plus the DOM
// HUD (health, ammo, timer, score, plant bar, banner, title menu) laid out
// at 1280x800. Nothing is drawn by hand, nothing is composited from parts,
// no pixel is invented: the browser rasterises the real page into the PNG.
// The <a download> anchor stays in the DOM (id="shot-download") so a
// capturing agent can click it again if the automatic download does not
// register. window.__shotReady is set only after the download has started,
// and window.__shotExport names which path produced the file.
const SHOT_EXPORT = { start: '1-start.png', play: '2-play.png', plant: '3-plant.png', end: '4-end.png' };

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.id = 'shot-download';
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  a.textContent = `Download ${filename}`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return a;
}

// PNG first; if the PNG busts the 256 KiB gate, JPEG (allowed by the gate)
// at the same shot name with a .jpg extension.
function downloadWithSizeCap(canvas2d, pngName, done) {
  canvas2d.toBlob((png) => {
    if (png && png.size <= 262144) {
      downloadBlob(png, pngName);
      done('page-png');
      return;
    }
    canvas2d.toBlob((jpg) => {
      if (jpg) downloadBlob(jpg, pngName.replace(/\.png$/, '.jpg'));
      done(jpg ? 'page-jpeg' : 'error');
    }, 'image/jpeg', 0.85);
  }, 'image/png');
}

function exportShotFrame() {
  const pngName = SHOT_EXPORT[shot] || 'shot.png';
  const finish = (mode) => {
    window.__shotExport = mode;
    window.__shotReady = true;
    frozen = true;
  };
  // 1. The 3D frame, captured synchronously in the same task as the render
  //    above, so the drawing buffer is still valid.
  const sceneUrl = renderer.domElement.toDataURL('image/png');
  // 2. The full page at 1280x800: clone the document, swap the live WebGL
  //    canvas for the captured frame (same pixels), drop the scripts, and let
  //    the browser rasterise the page — 3D plus DOM HUD — into one image.
  try {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script').forEach((s) => s.remove());
    const sceneImg = document.createElement('img');
    sceneImg.setAttribute('src', sceneUrl);
    sceneImg.setAttribute('width', '1280');
    sceneImg.setAttribute('height', '800');
    sceneImg.setAttribute('style', 'width:100%;height:100%;display:block;');
    const cloneCanvas = clone.querySelector('#game canvas');
    if (cloneCanvas) cloneCanvas.replaceWith(sceneImg);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">'
      + '<foreignObject x="0" y="0" width="1280" height="800">'
      + new XMLSerializer().serializeToString(clone)
      + '</foreignObject></svg>';
    const raster = new Image();
    raster.onload = () => {
      try {
        const out = document.createElement('canvas');
        out.width = 1280;
        out.height = 800;
        out.getContext('2d').drawImage(raster, 0, 0, 1280, 800);
        downloadWithSizeCap(out, pngName, finish);
      } catch (err) {
        fallbackCanvasOnly(sceneUrl, pngName, finish);
      }
    };
    raster.onerror = () => fallbackCanvasOnly(sceneUrl, pngName, finish);
    raster.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  } catch (err) {
    fallbackCanvasOnly(sceneUrl, pngName, finish);
  }
}

function fallbackCanvasOnly(sceneUrl, pngName, finish) {
  // The full-page raster failed (e.g. the browser tainted the canvas): fall
  // back to the 3D render alone. Still a real render of the game at 1280x800,
  // just without the DOM HUD — a valid screenshot beats no screenshot.
  fetch(sceneUrl).then((res) => res.blob()).then((png) => {
    if (png.size <= 262144) {
      downloadBlob(png, pngName);
      finish('canvas-png');
      return;
    }
    const img = new Image();
    img.onload = () => {
      const out = document.createElement('canvas');
      out.width = 1280;
      out.height = 800;
      out.getContext('2d').drawImage(img, 0, 0, 1280, 800);
      out.toBlob((jpg) => {
        if (jpg) downloadBlob(jpg, pngName.replace(/\.png$/, '.jpg'));
        finish(jpg ? 'canvas-jpeg' : 'error');
      }, 'image/jpeg', 0.85);
    };
    img.onerror = () => finish('error');
    img.src = sceneUrl;
  }).catch(() => finish('error'));
}

function runShot(name) {
  // Shot mode: banners never auto-hide (the frozen frame must keep them), and
  // the staged frame is rendered at exactly 1280x800 — the size the export
  // writes. The canvas CSS still fills the window (updateStyle false), so the
  // live view looks stretched; the exported file is a true 1280x800 render.
  hud.setShotMode(true);
  renderer.setPixelRatio(1);
  renderer.setSize(1280, 800, false);
  camera.aspect = 1280 / 800;
  camera.updateProjectionMatrix();
  hud.hideOverlay();
  hud.hideBanner();
  // Skip the buy phase: the shot is a live round.
  sim.phase = 'live';
  sim.timer = 100;
  if (name === 'start') {
    player.pos = { x: 0, y: 0, z: 13 };
    settle(240);
    aimAt({ x: 0, y: 1.5, z: -8 });
    hud.showOverlay('start');
  } else if (name === 'play') {
    player.pos = { x: 0, y: 0, z: 9 };
    const ally = sim.entities.find((e) => e.id === 'ally-0');
    ally.pos = { x: -2.5, y: 0, z: 7 };
    ally.yaw = 0;
    const foe = sim.entities.find((e) => e.id === 'enemy-0');
    foe.pos = { x: 3, y: 0, z: -1 };
    foe.yaw = Math.PI;
    settle(30);
    aimAt({ x: foe.pos.x, y: 1.2, z: foe.pos.z });
    shoot();
    settle(10);
    aimAt({ x: foe.pos.x, y: 1.2, z: foe.pos.z });
  } else if (name === 'plant') {
    player.pos = { x: 16, y: 0, z: -6.5 };
    const foe = sim.entities.find((e) => e.id === 'enemy-2');
    foe.pos = { x: -10, y: 0, z: -4 };
    settle(30);
    sim.bomb.plantProgress = 2.9;
    aimAt({ x: 10, y: 1.2, z: -4 });
    pushHud();
  } else {
    // end: a round just won, banner up, the yard behind it.
    player.pos = { x: 8, y: 0, z: -2 };
    sim.match.attack = 1;
    sim.roundWinner = 'attack';
    sim.phase = 'over';
    settle(20);
    aimAt({ x: 16, y: 1.5, z: -6.5 });
    hud.showBanner('roundWin');
  }
  refreshAmmoHud();
  pushHud();
  paintTwiceThenReady();
}

hud.onPlay(() => {
  if (shot) return;
  if (sim.matchOver) {
    window.location.reload();
    return;
  }
  input.requestLock();
});

hud.onBuy((itemId) => {
  if (sim.buy(itemId)) {
    refreshAmmoHud();
    hud.setBuy(true, sim.money, ownedWeapons());
  }
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    started = true;
    hud.hideOverlay();
    if (buyOpen) {
      buyOpen = false;
      hud.setBuy(false, sim.money, ownedWeapons());
    }
  } else if (!sim.matchOver && sim.phase !== 'over') {
    if (buyOpen) return; // the buy menu owns the mouse right now
    hud.showOverlay(started ? 'paused' : 'start');
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

syncCamera();
refreshAmmoHud();
pushHud();
if (shot) runShot(shot);
else requestAnimationFrame(frame);
