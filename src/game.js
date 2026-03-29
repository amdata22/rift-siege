import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { AudioManager } from "./audio.js";
import { GAME_CONFIG, DIFFICULTIES, MATERIAL_PRESETS, STORAGE_KEY, WEAPON_FLASH_COLORS } from "./config.js";
import { LEVELS } from "./levelData.js";
import { JOURNAL_ENTRIES, JOURNAL_BY_ID, getJournalTotalCount } from "./journalData.js";
import { Hud } from "./hud.js";
import { rand, clamp01, damageWithFalloff, planarDistanceXZ, splashFalloff } from "./utils.js";

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

const TMP_V1 = new THREE.Vector3();
const TMP_V2 = new THREE.Vector3();
const TMP_V3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const ROOM_STEP = 12;
const WALL_HEIGHT = 3;
const WALL_THICKNESS = 0.2;
const DOOR_WIDTH = 2;

function mapRoomTone(levelAmbience) {
  if (levelAmbience === "clean") {
    return {
      sky: 0x2b3950,
      ground: 0x1a2432,
      hemiIntensity: 1.25,
      ambientIntensity: 0.9,
      strip: 0xecf7ff,
      stripIntensity: 3.2,
      wallColor: 0x555e6a,
      floorColor: 0x4a5260,
      infested: false,
      alarm: false,
    };
  }
  if (levelAmbience === "mixed") {
    return {
      sky: 0x253243,
      ground: 0x161f2a,
      hemiIntensity: 1.1,
      ambientIntensity: 0.75,
      strip: 0xe8f3ff,
      stripIntensity: 2.8,
      wallColor: 0x4d5560,
      floorColor: 0x434b56,
      infested: true,
      alarm: false,
    };
  }
  if (levelAmbience === "infested") {
    return {
      sky: 0x212d3c,
      ground: 0x141c26,
      hemiIntensity: 0.95,
      ambientIntensity: 0.62,
      strip: 0xe1efff,
      stripIntensity: 2.4,
      wallColor: 0x3e4a4a,   // slightly green-grey — reactor contamination
      floorColor: 0x363f3f,
      infested: true,
      alarm: true,
    };
  }
  // rift
  return {
    sky: 0x1e2d3a,
    ground: 0x0f1820,
    hemiIntensity: 0.9,
    ambientIntensity: 0.6,
    strip: 0xb8d4ff,
    stripIntensity: 2.2,
    wallColor: 0x2e3a4a,   // deep blue-teal — portal energy
    floorColor: 0x273040,
    infested: true,
    alarm: true,
  };
}

class Enemy {
  constructor(type, mesh, stats, roomIndex) {
    this.type = type;
    this.mesh = mesh;
    this.stats = { ...stats };
    this.roomIndex = roomIndex;
    this.maxHp = stats.hp;
    this.hp = stats.hp;
    this.state = "PATROL";
    this.attackCooldown = 0;
    this.alertTimer = 0;
    this.lastKnownPlayerPos = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.deadTime = 0;
    this.freezeRagdoll = false;
    this.staggerTimer = 0;
    this.reanimateTimer = 0;
    this.reanimateTarget = null;
    this.moanEmitted = false;
    this.attackMode = "none";
    this.attackTimer = 0;
    this.comboTimer = 0;
    this.comboStep = 0;
    this.sprintActive = false;
    this.movementDir = new THREE.Vector3(0, 0, -1);
    this.recentHitTimer = 0;
    this.recentHitCount = 0;
    this.grabTickTimer = 0;
    this.grabTimer = 0;
    this.deathFallAxis = new THREE.Vector3(1, 0, 0);
    this.deathTilt = 0;
    this.deathTiltTarget = 0;
    this.deathTiltSpeed = 0;
    this.deathStartQuaternion = new THREE.Quaternion();
    this.deathGroundY = 0.9;
    // Limb animation clock
    this.animTime = Math.random() * Math.PI * 2;
    // Hit-flash: positive while flashing red
    this.hitFlashTimer = 0;
    this.woundSlowTimer = 0;
    this.woundSlowFactor = 1;
  }
}

class Door {
  constructor(mesh, panel, roomIndex, requiredKey = null) {
    this.mesh = mesh;
    this.panel = panel;
    this.roomIndex = roomIndex;
    this.requiredKey = requiredKey;
    this.locked = !!requiredKey;
    this.open = false;
    this.openAmount = 0;
    this.triggered = false;
  }
}

class Pickup {
  constructor(mesh, kind, amount = 0, keyColor = null, weaponId = null, journalId = null) {
    this.mesh = mesh;
    this.kind = kind;
    this.amount = amount;
    this.keyColor = keyColor;
    this.weaponId = weaponId;
    this.journalId = journalId;
  }
}

class RiftAnchor {
  constructor(mesh, pulseLight) {
    this.mesh = mesh;
    this.pulseLight = pulseLight;
    this.destroyed = false;
    this.holdProgress = 0;
  }
}

export class AlienXGame {
  constructor(root) {
    this.root = root;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.composer = null;
    this.controls = null;
    this.clock = new THREE.Clock();
    this.gltfLoader = new GLTFLoader();

    this.gameStarted = false;
    this.gameOver = false;
    this.win = false;

    this.input = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      crouch: false,
      sprint: false,
      interact: false,
      fireHeld: false,
      adsHeld: false,
    };

    this.stats = {
      shots: 0,
      hits: 0,
      kills: 0,
      startedAt: 0,
    };

    this.difficulty = DIFFICULTIES.normal;
    this.difficultyKey = "normal";
    this.levelIndex = 0;
    this.level = null;
    this.levelGroup = null;
    this.staticMeshes = [];
    this.collisionBoxes = [];
    this.flickerLights = [];
    this.rotatingAlarmLights = [];
    this.interactables = [];
    this.doors = [];
    this.pickups = [];
    this.enemies = [];
    this.playerProjectiles = [];
    this.corpses = [];
    this.anchors = [];
    this.riftTimer = 0;
    this.riftSparkTimer = 0;
    this.ventBursts = [];
    this.crates = [];
    this.gibChunks = [];
    this.oneFrameLights = [];
    this.broadcastScreens = [];
    this.scriptedEvents = [];
    this.trackerGhostBlips = [];
    this.combatCooldown = 0;
    this.levelTransitioning = false;
    this.deathCinematicTimer = 0;
    this.levelTime = 0;
    this.paStaticTimer = rand(30, 90);
    this.phoneRingTimer = 0;
    this.phoneActive = false;
    this.deferredCrawlerCount = 0;
    /** @type {Set<string>} journal entry ids collected this run */
    this.collectedJournalIds = new Set();

    this.player = {
      hp: 100,
      maxHp: 100,
      unlimitedHealth: false,
      shield: GAME_CONFIG.player.maxShield,
      maxShield: GAME_CONFIG.player.maxShield,
      shieldRechargeTimer: 0,
      ads: false,
      adsT: 0,
      crouchT: 0,
      sprintT: 0,
      bobPhase: 0,
      bobStepIndex: 0,
      yaw: 0,
      lastPosition: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      interactingWith: null,
      interactionHold: 0,
      dead: false,
      controlStunTimer: 0,
      knockbackVelocity: new THREE.Vector3(),
      grabbedBy: null,
      grabMashMeter: 0,
    };

    this.meleeCooldown = 0;
    this.cameraShake = { x: 0, y: 0, intensity: 0, timer: 0 };
    this.sparkParticles = [];
    this.shellCasings = [];

    const arCfg = GAME_CONFIG.weapons.ar;
    const m6dCfg = GAME_CONFIG.weapons.m6d;
    const shotgunCfg = GAME_CONFIG.weapons.shotgun;
    this.weapons = {
      ar: {
        ...arCfg,
        unlocked: true,
        mag: arCfg.magSize,
        reserve: 120,
      },
      m6d: {
        ...m6dCfg,
        unlocked: true,
        mag: m6dCfg.magSize,
        reserve: 36,
      },
      shotgun: {
        ...shotgunCfg,
        unlocked: true,
        mag: shotgunCfg.magSize,
        reserve: 24,
      },
      plasma: {
        ...GAME_CONFIG.weapons.plasma,
        unlocked: false,
        mag: GAME_CONFIG.weapons.plasma.magSize,
        reserve: 0,
        overheat: 0,
        cooldown: 0,
        burstShotsQueued: 0,
        burstIntervalTimer: 0,
        burstResetTimer: 0,
      },
      grenade: {
        ...GAME_CONFIG.weapons.grenade,
        unlocked: false,
        mag: 0,
        reserve: 0,
        pumpTimer: 0,
      },
      sniper: {
        ...GAME_CONFIG.weapons.sniper,
        unlocked: false,
        mag: 0,
        reserve: 0,
        pumpTimer: 0,
      },
    };
    this.currentWeaponId = "ar";
    this.fireCooldown = 0;
    this.reloadTimer = 0;
    this.reloadTargetWeaponId = null;
    this.reloadTimeouts = [];
    this.reloadAnim = { active: false, t: 0, totalTime: 1.6, weaponId: null };
    this.recoil = {
      active: false,
      t: 0,
      scale: 1,
      offsetZ: 0,
      rotX: 0,
      offsetX: 0,
      rotZ: 0,
      lateralKick: 0,
      rollKick: 0,
      snap: 1,
      recover: 1,
    };
    this.muzzleFlashPending = false;
    this.weaponSwitchAnim = { t: 1.0, fromId: null }; // t=1 = fully up/settled

    this.audio = new AudioManager();
    this.hud = null;
    this.menuRoot = null;
    this.interactPrompt = null;

    this.headBobAmplitude = GAME_CONFIG.player.headBobAmplitude;
    this.adsBobMultiplier = 0.3;
    this.stepTimer = 0;
    this.trackerTimer = 0;
    this.lastTrackerBlipCount = 0;
    this.lastFrameAt = performance.now();
  }

  async init() {
    RectAreaLightUniformsLib.init();
    this.#initRenderer();
    this.#initScene();
    this.#initPlayerRig();
    this.#initEvents();

    this.levelGroup = new THREE.Group();
    this.scene.add(this.levelGroup);

    this.root.appendChild(this.renderer.domElement);
    this.#initOverlay();
    this.hud = new Hud(this.root);
    this.hud.updateHealth(this.player.hp);
    this.hud.updateShield(this.player.shield, this.player.maxShield);
    this.hud.updateAmmo(this.weapons.ar.name, this.weapons.ar.mag, this.weapons.ar.reserve, false);
    this.hud.setJournalProgress(0, getJournalTotalCount());

    this.#showStartMenu();
    this.#animate();
  }

  #initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = GAME_CONFIG.renderer.exposure;
  }

  #initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d131d);
    this.scene.fog = new THREE.Fog(0x111927, 22, 92);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 140);
    this.camera.position.set(0, GAME_CONFIG.player.eyeHeight, 2);
    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);
    const controlsObject = typeof this.controls.getObject === "function" ? this.controls.getObject() : this.controls.object || this.camera;
    this.scene.add(controlsObject);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.ssaoPass = new SSAOPass(this.scene, this.camera, window.innerWidth, window.innerHeight);
    this.ssaoPass.kernelRadius = GAME_CONFIG.renderer.ssaoRadius * 16;
    this.ssaoPass.minDistance = 0.001;
    this.ssaoPass.maxDistance = 0.15;
    this.ssaoPass.aoClamp = GAME_CONFIG.renderer.ssaoIntensity;
    this.composer.addPass(this.ssaoPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      GAME_CONFIG.renderer.bloomStrength,
      GAME_CONFIG.renderer.bloomRadius,
      GAME_CONFIG.renderer.bloomThreshold
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  #initPlayerRig() {
    this.viewModel = new THREE.Group();
    this.camera.add(this.viewModel);
    this.weaponViewModels = {};

    const addPart = (group, geometry, material, position, rotation = null) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      if (rotation) {
        mesh.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
      }
      group.add(mesh);
      return mesh;
    };
    // ── Material palette ───────────────────────────────────────────────────
    const armorMat   = new THREE.MeshStandardMaterial({ color: 0x1e2736, metalness: 0.88, roughness: 0.22 });
    const plateMat   = new THREE.MeshStandardMaterial({ color: 0x2c3545, metalness: 0.65, roughness: 0.42 });
    const ceramicMat = new THREE.MeshStandardMaterial({ color: 0x4a5668, metalness: 0.30, roughness: 0.62 });
    const gripMat    = new THREE.MeshStandardMaterial({ color: 0x111820, metalness: 0.12, roughness: 0.90 });
    const emitterMat = new THREE.MeshStandardMaterial({
      color: 0x1a2d40, emissive: 0x4dd8ff, emissiveIntensity: 1.1,
      metalness: 0.4, roughness: 0.28,
    });
    const displayMat = new THREE.MeshStandardMaterial({
      color: 0x0a1520, emissive: 0x00aaff, emissiveIntensity: 0.85,
      metalness: 0.1, roughness: 0.5,
    });
    const muzzleMat  = new THREE.MeshStandardMaterial({
      color: 0x0d1c2a, emissive: 0x66eeff, emissiveIntensity: 0.75,
      metalness: 0.45, roughness: 0.22,
    });
    const sniperStockMat = new THREE.MeshStandardMaterial({ color: 0x1a2030, metalness: 0.8, roughness: 0.25 });

    // ── M6D Magnum (Halo-style chunky semi-auto) ───────────────────────────
    const pistolGroup = new THREE.Group();
    // Slide / upper receiver — blocky, angular
    addPart(pistolGroup, new THREE.BoxGeometry(0.24, 0.14, 0.48), armorMat,  new THREE.Vector3(0.148, -0.170, -0.46));
    addPart(pistolGroup, new THREE.BoxGeometry(0.20, 0.06, 0.34), plateMat,  new THREE.Vector3(0.148, -0.092, -0.45));
    // Extended compensated barrel
    addPart(pistolGroup, new THREE.CylinderGeometry(0.026, 0.026, 0.38, 8), armorMat, new THREE.Vector3(0.148, -0.172, -0.70), { x: Math.PI * 0.5 });
    addPart(pistolGroup, new THREE.CylinderGeometry(0.019, 0.019, 0.30, 8), muzzleMat, new THREE.Vector3(0.148, -0.172, -0.70), { x: Math.PI * 0.5 });
    // Compensator slots (emissive vents)
    addPart(pistolGroup, new THREE.BoxGeometry(0.052, 0.014, 0.07), emitterMat, new THREE.Vector3(0.148, -0.148, -0.82));
    addPart(pistolGroup, new THREE.BoxGeometry(0.052, 0.014, 0.07), emitterMat, new THREE.Vector3(0.148, -0.148, -0.65));
    // Grip
    addPart(pistolGroup, new THREE.BoxGeometry(0.088, 0.162, 0.078), gripMat, new THREE.Vector3(0.140, -0.278, -0.352), { x: 0.09, z: -0.22 });
    // Tactical rail (bottom)
    addPart(pistolGroup, new THREE.BoxGeometry(0.08, 0.028, 0.22), plateMat, new THREE.Vector3(0.148, -0.198, -0.53));
    // Sight / emitter node on top
    addPart(pistolGroup, new THREE.BoxGeometry(0.034, 0.028, 0.095), emitterMat, new THREE.Vector3(0.148, -0.062, -0.52), { y: 0.0 });
    // Muzzle ring
    addPart(pistolGroup, new THREE.TorusGeometry(0.030, 0.005, 8, 18), muzzleMat, new THREE.Vector3(0.148, -0.172, -0.87), { x: Math.PI * 0.5 });
    this.viewModel.add(pistolGroup);

    // ── MA5 Assault Rifle (Halo-style bullpup) ─────────────────────────────
    const arGroup = new THREE.Group();
    // Main body — wider, squarer
    addPart(arGroup, new THREE.BoxGeometry(0.26, 0.145, 0.78), armorMat,  new THREE.Vector3(0.158, -0.195, -0.57));
    addPart(arGroup, new THREE.BoxGeometry(0.20, 0.085, 0.54), plateMat,  new THREE.Vector3(0.158, -0.124, -0.57));
    // Top picatinny rail
    addPart(arGroup, new THREE.BoxGeometry(0.22, 0.018, 0.60), ceramicMat, new THREE.Vector3(0.158, -0.050, -0.57));
    // Barrel shroud (octagonal look using stacked boxes at 45°)
    addPart(arGroup, new THREE.CylinderGeometry(0.033, 0.033, 0.54, 8), armorMat,  new THREE.Vector3(0.158, -0.166, -0.96), { x: Math.PI * 0.5 });
    addPart(arGroup, new THREE.CylinderGeometry(0.024, 0.024, 0.46, 8), muzzleMat, new THREE.Vector3(0.158, -0.166, -0.96), { x: Math.PI * 0.5 });
    // Muzzle brake / emitter ring
    addPart(arGroup, new THREE.TorusGeometry(0.036, 0.006, 8, 20), emitterMat, new THREE.Vector3(0.158, -0.166, -1.24), { x: Math.PI * 0.5 });
    addPart(arGroup, new THREE.CylinderGeometry(0.018, 0.018, 0.06, 8), emitterMat, new THREE.Vector3(0.158, -0.166, -1.26), { x: Math.PI * 0.5 });
    // Pistol grip
    addPart(arGroup, new THREE.BoxGeometry(0.082, 0.178, 0.114), gripMat, new THREE.Vector3(0.142, -0.285, -0.465), { x: 0.065, z: -0.20 });
    // Foregrip
    addPart(arGroup, new THREE.BoxGeometry(0.086, 0.130, 0.092), gripMat, new THREE.Vector3(0.155, -0.270, -0.755), { x: 0.08, z: 0.05 });
    // Ammo counter display strip (side emissive LCD panel)
    addPart(arGroup, new THREE.BoxGeometry(0.014, 0.058, 0.18), displayMat, new THREE.Vector3(0.058, -0.160, -0.58));
    // Side emitter nodes
    addPart(arGroup, new THREE.BoxGeometry(0.022, 0.042, 0.115), emitterMat, new THREE.Vector3(0.062, -0.142, -0.64), { y: 0.22 });
    // Carry handle / scope rail
    addPart(arGroup, new THREE.BoxGeometry(0.024, 0.046, 0.28), plateMat, new THREE.Vector3(0.158, -0.038, -0.90));
    this.viewModel.add(arGroup);

    // ── M90 Shotgun (Halo-style heavy close-quarters) ──────────────────────
    const shotgunGroup = new THREE.Group();
    // Thick boxy receiver
    addPart(shotgunGroup, new THREE.BoxGeometry(0.195, 0.138, 0.44), armorMat,  new THREE.Vector3(0.138, -0.194, -0.48));
    // Pump handle
    addPart(shotgunGroup, new THREE.BoxGeometry(0.148, 0.096, 0.28), gripMat, new THREE.Vector3(0.138, -0.205, -0.70));
    // Grip (pistol)
    addPart(shotgunGroup, new THREE.BoxGeometry(0.108, 0.168, 0.088), gripMat, new THREE.Vector3(0.128, -0.285, -0.408), { x: 0.085, z: -0.26 });
    // Dual barrels (side-by-side)
    addPart(shotgunGroup, new THREE.CylinderGeometry(0.026, 0.026, 0.64, 8), armorMat, new THREE.Vector3(0.105, -0.166, -0.95), { x: Math.PI * 0.5 });
    addPart(shotgunGroup, new THREE.CylinderGeometry(0.026, 0.026, 0.64, 8), armorMat, new THREE.Vector3(0.170, -0.166, -0.95), { x: Math.PI * 0.5 });
    // Energy charge rings (emissive)
    addPart(shotgunGroup, new THREE.TorusGeometry(0.038, 0.006, 8, 18), emitterMat, new THREE.Vector3(0.137, -0.166, -0.70), { x: Math.PI * 0.5 });
    addPart(shotgunGroup, new THREE.TorusGeometry(0.038, 0.006, 8, 18), emitterMat, new THREE.Vector3(0.137, -0.166, -0.90), { x: Math.PI * 0.5 });
    addPart(shotgunGroup, new THREE.TorusGeometry(0.038, 0.006, 8, 18), emitterMat, new THREE.Vector3(0.137, -0.166, -1.22), { x: Math.PI * 0.5 });
    // Top rib
    addPart(shotgunGroup, new THREE.BoxGeometry(0.022, 0.026, 0.55), ceramicMat, new THREE.Vector3(0.137, -0.094, -0.82));
    // Side ammo display
    addPart(shotgunGroup, new THREE.BoxGeometry(0.014, 0.042, 0.14), displayMat, new THREE.Vector3(0.062, -0.148, -0.52));
    this.viewModel.add(shotgunGroup);

    // ── SRS99 Sniper Rifle (long-range precision) ──────────────────────────
    const sniperGroup = new THREE.Group();
    // Receiver
    addPart(sniperGroup, new THREE.BoxGeometry(0.22, 0.110, 0.85), armorMat, new THREE.Vector3(0.15, -0.185, -0.62));
    // Scope body
    addPart(sniperGroup, new THREE.CylinderGeometry(0.030, 0.030, 0.48, 10), sniperStockMat, new THREE.Vector3(0.15, -0.072, -0.62), { x: Math.PI * 0.5 });
    addPart(sniperGroup, new THREE.CylinderGeometry(0.022, 0.022, 0.10, 10), muzzleMat, new THREE.Vector3(0.15, -0.072, -0.42), { x: Math.PI * 0.5 });
    addPart(sniperGroup, new THREE.CylinderGeometry(0.022, 0.022, 0.10, 10), muzzleMat, new THREE.Vector3(0.15, -0.072, -0.82), { x: Math.PI * 0.5 });
    // Barrel (long and sleek)
    addPart(sniperGroup, new THREE.CylinderGeometry(0.020, 0.018, 0.80, 10), armorMat, new THREE.Vector3(0.15, -0.180, -1.08), { x: Math.PI * 0.5 });
    // Muzzle brake
    addPart(sniperGroup, new THREE.CylinderGeometry(0.028, 0.028, 0.09, 8), plateMat, new THREE.Vector3(0.15, -0.180, -1.49), { x: Math.PI * 0.5 });
    addPart(sniperGroup, new THREE.TorusGeometry(0.026, 0.005, 8, 18), emitterMat, new THREE.Vector3(0.15, -0.180, -1.53), { x: Math.PI * 0.5 });
    // Grip
    addPart(sniperGroup, new THREE.BoxGeometry(0.082, 0.165, 0.105), gripMat, new THREE.Vector3(0.142, -0.278, -0.435), { x: 0.065, z: -0.18 });
    // Stock
    addPart(sniperGroup, new THREE.BoxGeometry(0.18, 0.098, 0.38), plateMat, new THREE.Vector3(0.15, -0.205, -0.22));
    // Bipod legs (folded, aesthetic)
    addPart(sniperGroup, new THREE.BoxGeometry(0.012, 0.08, 0.012), ceramicMat, new THREE.Vector3(0.118, -0.238, -0.90));
    addPart(sniperGroup, new THREE.BoxGeometry(0.012, 0.08, 0.012), ceramicMat, new THREE.Vector3(0.182, -0.238, -0.90));
    // Scope reticle glow
    addPart(sniperGroup, new THREE.BoxGeometry(0.008, 0.008, 0.02), emitterMat, new THREE.Vector3(0.15, -0.072, -0.62));
    this.viewModel.add(sniperGroup);

    // ── Plasma Rifle (energy weapon — sleek, cyan emissive) ────────────────
    const plasmaGroup = new THREE.Group();
    const plasmaHullMat = new THREE.MeshStandardMaterial({ color: 0x0d1e2e, metalness: 0.85, roughness: 0.20 });
    const plasmaCellMat = new THREE.MeshStandardMaterial({
      color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 2.0,
      metalness: 0.0, roughness: 0.4,
    });
    const plasmaVentMat = new THREE.MeshStandardMaterial({
      color: 0x80ffee, emissive: 0x40ffdd, emissiveIntensity: 1.4,
      metalness: 0.2, roughness: 0.35,
    });
    // Lower receiver / body
    addPart(plasmaGroup, new THREE.BoxGeometry(0.20, 0.115, 0.62), plasmaHullMat, new THREE.Vector3(0.148, -0.185, -0.53));
    // Top rail + heat sink fins (stacked thin plates)
    addPart(plasmaGroup, new THREE.BoxGeometry(0.22, 0.012, 0.54), plateMat, new THREE.Vector3(0.148, -0.124, -0.53));
    addPart(plasmaGroup, new THREE.BoxGeometry(0.20, 0.012, 0.46), plateMat, new THREE.Vector3(0.148, -0.112, -0.53));
    addPart(plasmaGroup, new THREE.BoxGeometry(0.18, 0.012, 0.38), plateMat, new THREE.Vector3(0.148, -0.100, -0.53));
    // Barrel housing — cylindrical
    addPart(plasmaGroup, new THREE.CylinderGeometry(0.024, 0.024, 0.76, 10), plasmaHullMat, new THREE.Vector3(0.148, -0.168, -1.02), { x: Math.PI * 0.5 });
    // Inner emissive barrel (cyan glow core)
    addPart(plasmaGroup, new THREE.CylinderGeometry(0.013, 0.013, 0.78, 8), plasmaCellMat, new THREE.Vector3(0.148, -0.168, -1.02), { x: Math.PI * 0.5 });
    // Charging coil rings (4 rings along barrel)
    const plasmaRings = [];
    for (let ri = 0; ri < 4; ri += 1) {
      const ring = addPart(plasmaGroup, new THREE.TorusGeometry(0.030, 0.005, 8, 18), plasmaCellMat.clone(), new THREE.Vector3(0.148, -0.168, -0.72 - ri * 0.17), { x: Math.PI * 0.5 });
      plasmaRings.push(ring);
    }
    // Muzzle emitter (larger flared opening)
    addPart(plasmaGroup, new THREE.CylinderGeometry(0.040, 0.026, 0.07, 10), plasmaVentMat, new THREE.Vector3(0.148, -0.168, -1.43), { x: Math.PI * 0.5 });
    addPart(plasmaGroup, new THREE.TorusGeometry(0.038, 0.007, 8, 20), plasmaCellMat, new THREE.Vector3(0.148, -0.168, -1.46), { x: Math.PI * 0.5 });
    // Energy cell magazine (right side, glowing block)
    addPart(plasmaGroup, new THREE.BoxGeometry(0.055, 0.07, 0.22), plasmaCellMat, new THREE.Vector3(0.062, -0.178, -0.64));
    addPart(plasmaGroup, new THREE.BoxGeometry(0.068, 0.09, 0.26), plasmaHullMat, new THREE.Vector3(0.062, -0.175, -0.64));
    // Vent slots on body sides (emissive)
    addPart(plasmaGroup, new THREE.BoxGeometry(0.016, 0.028, 0.28), plasmaVentMat, new THREE.Vector3(0.058, -0.168, -0.58));
    // Pistol grip
    addPart(plasmaGroup, new THREE.BoxGeometry(0.082, 0.160, 0.085), gripMat, new THREE.Vector3(0.140, -0.278, -0.430), { x: 0.085, z: -0.22 });
    this.viewModel.add(plasmaGroup);
    this.plasmaChargeRings = plasmaRings;

    // ── M319 Grenade Launcher (revolving cylinder) ─────────────────────────
    const grenadeGroup = new THREE.Group();
    const grenadeHullMat = new THREE.MeshStandardMaterial({ color: 0x2a3540, metalness: 0.78, roughness: 0.38 });
    const grenadeCylMat  = new THREE.MeshStandardMaterial({ color: 0x1c2a34, metalness: 0.88, roughness: 0.28 });
    const grenadeWarnMat = new THREE.MeshStandardMaterial({
      color: 0xff6200, emissive: 0xff3800, emissiveIntensity: 0.65,
      metalness: 0.3, roughness: 0.6,
    });
    // Main body — blocky, angular
    addPart(grenadeGroup, new THREE.BoxGeometry(0.28, 0.168, 0.58), grenadeHullMat, new THREE.Vector3(0.148, -0.192, -0.52));
    // Top carry handle / scope rail
    addPart(grenadeGroup, new THREE.BoxGeometry(0.022, 0.052, 0.30), plateMat, new THREE.Vector3(0.148, -0.106, -0.64));
    // Revolving cylinder sub-group (rotates on Z axis when firing)
    const cylGroup = new THREE.Group();
    cylGroup.position.set(0.148, -0.192, -0.78);
    grenadeGroup.add(cylGroup);
    // Cylinder body
    const cylMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.090, 0.090, 0.32, 14), grenadeCylMat);
    cylMesh.rotation.x = Math.PI * 0.5;
    cylGroup.add(cylMesh);
    // Chamber holes (6 warheads visible as orange dots, local coords centered)
    for (let ci = 0; ci < 6; ci += 1) {
      const ca = (ci / 6) * Math.PI * 2;
      const chamberMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.32, 6), grenadeWarnMat);
      chamberMesh.rotation.x = Math.PI * 0.5;
      chamberMesh.position.set(Math.sin(ca) * 0.058, Math.cos(ca) * 0.058, 0);
      cylGroup.add(chamberMesh);
    }
    this.grenadeCylGroup = cylGroup;
    this.grenadeCylAngle = 0;
    this.grenadeCylTargetAngle = 0;
    // Barrel (wide, short)
    addPart(grenadeGroup, new THREE.CylinderGeometry(0.058, 0.058, 0.48, 10), grenadeHullMat, new THREE.Vector3(0.148, -0.165, -1.04), { x: Math.PI * 0.5 });
    addPart(grenadeGroup, new THREE.CylinderGeometry(0.042, 0.042, 0.48, 8), grenadeCylMat, new THREE.Vector3(0.148, -0.165, -1.04), { x: Math.PI * 0.5 });
    // Muzzle crown
    addPart(grenadeGroup, new THREE.CylinderGeometry(0.066, 0.060, 0.065, 10), grenadeHullMat, new THREE.Vector3(0.148, -0.165, -1.30), { x: Math.PI * 0.5 });
    // Pump foregrip
    addPart(grenadeGroup, new THREE.BoxGeometry(0.092, 0.092, 0.19), gripMat, new THREE.Vector3(0.148, -0.215, -0.72));
    // Pistol grip
    addPart(grenadeGroup, new THREE.BoxGeometry(0.085, 0.175, 0.095), gripMat, new THREE.Vector3(0.142, -0.292, -0.435), { x: 0.07, z: -0.25 });
    // Ammo counter display
    addPart(grenadeGroup, new THREE.BoxGeometry(0.014, 0.038, 0.11), displayMat, new THREE.Vector3(0.062, -0.172, -0.54));
    this.viewModel.add(grenadeGroup);

    this.weaponViewModels.m6d = pistolGroup;
    this.weaponViewModels.ar = arGroup;
    this.weaponViewModels.shotgun = shotgunGroup;
    this.weaponViewModels.sniper = sniperGroup;
    this.weaponViewModels.plasma = plasmaGroup;
    this.weaponViewModels.grenade = grenadeGroup;
    this.#updateWeaponViewModelVisibility();
  }

  #placeLoadedWeaponModel(group, modelRoot, options = {}) {
    const rawBox = new THREE.Box3().setFromObject(modelRoot);
    if (rawBox.isEmpty()) return false;
    const rawSize = rawBox.getSize(new THREE.Vector3());
    const longest = Math.max(rawSize.x, rawSize.y, rawSize.z);
    if (!Number.isFinite(longest) || longest <= 0.0001) return false;

    const targetLength = options.targetLength || 0.7;
    const uniformScale = targetLength / longest;
    modelRoot.scale.setScalar(uniformScale);

    const scaledBox = new THREE.Box3().setFromObject(modelRoot);
    const center = scaledBox.getCenter(new THREE.Vector3());
    modelRoot.position.sub(center);
    const centeredBox = new THREE.Box3().setFromObject(modelRoot);
    modelRoot.position.y += -centeredBox.min.y;

    group.clear();
    group.add(modelRoot);
    if (options.offset) group.position.copy(options.offset);
    if (options.rotation) group.rotation.copy(options.rotation);
    return true;
  }

  #loadWeaponViewModelAsset(weaponId, url, options = {}) {
    const group = this.weaponViewModels?.[weaponId];
    if (!group) return;

    this.gltfLoader.load(
      url,
      (gltf) => {
        const source = gltf.scene || gltf.scenes?.[0];
        if (!source) return;
        const modelRoot = source.clone(true);
        modelRoot.traverse((obj) => {
          if (!obj.isMesh) return;
          obj.castShadow = false;
          obj.receiveShadow = false;
          obj.frustumCulled = false;
          if (obj.material) {
            obj.material = obj.material.clone();
            const texName = obj.material.normalMap?.name || "";
            if (texName.includes("DirectX")) {
              obj.material.normalScale = new THREE.Vector2(1, -1);
            }
          }
        });
        if (this.#placeLoadedWeaponModel(group, modelRoot, options)) {
          this.#updateWeaponViewModelVisibility();
        }
      },
      undefined,
      () => {}
    );
  }

  #initOverlay() {
    this.menuRoot = document.createElement("div");
    this.menuRoot.className = "overlay";
    this.root.appendChild(this.menuRoot);
  }

  #initEvents() {
    const keyMap = {
      KeyW: "forward",
      KeyS: "backward",
      KeyA: "left",
      KeyD: "right",
      KeyC: "crouch",
      KeyE: "interact",
      ShiftLeft: "sprint",
      ShiftRight: "sprint",
    };

    window.addEventListener("keydown", (ev) => {
      if (ev.code === "Escape" && this.hud?.isJournalLogOpen?.()) {
        ev.preventDefault();
        this.hud.toggleJournalLog(false);
        if (this.gameStarted && !this.gameOver && this.controls && !this.menuRoot?.querySelector(".menu-card")) {
          this.controls.lock();
        }
        return;
      }

      if (ev.code === "KeyJ" && this.gameStarted && !this.gameOver) {
        ev.preventDefault();
        const wasOpen = this.hud.isJournalLogOpen();
        this.hud.toggleJournalLog();
        this.#syncJournalHud();
        if (!wasOpen) {
          this.controls.unlock();
        } else if (!this.menuRoot?.querySelector(".menu-card")) {
          this.controls.lock();
        }
        return;
      }

      if (this.player.grabbedBy && (ev.code.startsWith("Key") || ev.code === "Space")) {
        this.player.grabMashMeter += 1;
      }
      if (ev.code in keyMap) this.input[keyMap[ev.code]] = true;

      if (ev.code === "Digit1") this.#switchWeapon("ar");
      if (ev.code === "Digit2") this.#switchWeapon("m6d");
      if (ev.code === "Digit3") this.#switchWeapon("shotgun");
      if (ev.code === "Digit4") this.#switchWeapon("plasma");
      if (ev.code === "Digit5") this.#switchWeapon("grenade");
      if (ev.code === "Digit6") this.#switchWeapon("sniper");
      if (ev.code === "KeyF") this.#fireMelee();
      if (ev.code === "KeyR") this.#startReload();
      if (ev.code === "F5") {
        ev.preventDefault();
        this.#manualSave();
      }
    });

    window.addEventListener("keyup", (ev) => {
      if (ev.code in keyMap) this.input[keyMap[ev.code]] = false;
    });

    this.renderer.domElement.addEventListener("mousedown", async (ev) => {
      if (!this.gameStarted || this.gameOver) return;
      if (ev.button === 0) {
        this.hud?.dismissJournalPickup?.();
      }
      await this.audio.resume();
      if (!this.controls.isLocked) {
        this.controls.lock();
        return;
      }
      if (ev.button === 0) {
        this.input.fireHeld = true;
        this.#tryFireClick();
      }
      if (ev.button === 2) {
        this.input.adsHeld = true;
        this.#setAds(true);
      }
    });

    this.renderer.domElement.addEventListener("mouseup", (ev) => {
      if (ev.button === 0) this.input.fireHeld = false;
      if (ev.button === 2) {
        this.input.adsHeld = false;
        this.#setAds(false);
      }
    });

    this.renderer.domElement.addEventListener("contextmenu", (ev) => ev.preventDefault());

    this.renderer.domElement.addEventListener("wheel", (ev) => {
      if (!this.gameStarted || this.gameOver) return;
      const order = ["ar", "m6d", "shotgun", "plasma", "grenade", "sniper"].filter((id) => this.weapons[id].unlocked);
      if (order.length < 2) return;
      const index = Math.max(0, order.indexOf(this.currentWeaponId));
      const next = ev.deltaY > 0 ? (index + 1) % order.length : (index - 1 + order.length) % order.length;
      this.#switchWeapon(order[next]);
    });

    window.addEventListener("resize", () => this.#onResize());
  }

  #showStartMenu() {
    const saved = this.#getSavedRunSummary();
    const continueButton = saved
      ? `<button data-action="continue">Continue (${saved.label})</button>`
      : "";

    this.menuRoot.innerHTML = `
      <div class="menu">
        <div class="menu-card">
          <h1>ALIEN X - MODERN REMAKE</h1>
          <p>Cygnus X has gone dark. Clear the station, survive swarms, and close the rift.</p>
          <p>Controls: WASD move, Shift sprint, C crouch, F melee, Mouse aim, LMB fire, RMB ADS, R reload, E interact, F5 save, J station logs, 1-6 switch weapons.</p>
          <div class="difficulty-row">
            <button data-diff="easy">Easy</button>
            <button data-diff="normal">Normal</button>
            <button data-diff="hard">Hard</button>
          </div>
          ${continueButton ? `<div class="difficulty-row">${continueButton}</div>` : ""}
        </div>
      </div>
    `;

    for (const btn of this.menuRoot.querySelectorAll("button[data-diff]")) {
      btn.addEventListener("click", async () => {
        await this.audio.resume();
        this.menuRoot.innerHTML = "";
        this.#startGame(btn.dataset.diff);
      });
    }

    const continueBtn = this.menuRoot.querySelector('button[data-action="continue"]');
    if (continueBtn) {
      continueBtn.addEventListener("click", async () => {
        await this.audio.resume();
        this.menuRoot.innerHTML = "";
        this.#startGame(saved.difficultyKey, { continueFromSave: true });
      });
    }
  }

  #showMessageMenu(title, lines, buttons) {
    const buttonHtml = buttons.map((btn) => `<button data-action="${btn.id}">${btn.label}</button>`).join("");
    const textHtml = lines.map((line) => `<p>${line}</p>`).join("");
    this.menuRoot.innerHTML = `
      <div class="menu">
        <div class="menu-card">
          <h1>${title}</h1>
          ${textHtml}
          <div class="difficulty-row">${buttonHtml}</div>
        </div>
      </div>
    `;
    for (const btn of this.menuRoot.querySelectorAll("button[data-action]")) {
      btn.addEventListener("click", () => {
        const id = btn.dataset.action;
        const selected = buttons.find((item) => item.id === id);
        if (selected) selected.onClick();
      });
    }
  }

  #startGame(difficultyKey, options = {}) {
    this.difficultyKey = difficultyKey;
    this.difficulty = DIFFICULTIES[difficultyKey] || DIFFICULTIES.normal;
    this.gameStarted = true;
    this.gameOver = false;
    this.win = false;
    this.stats = { shots: 0, hits: 0, kills: 0, startedAt: performance.now() };
    this.reloadTimer = 0;
    this.reloadTargetWeaponId = null;
    for (const timeoutId of this.reloadTimeouts) clearTimeout(timeoutId);
    this.reloadTimeouts.length = 0;

    this.player.hp = 100;
    this.player.dead = false;
    this.levelIndex = 0;
    this.currentWeaponId = "ar";
    this.weapons.ar.unlocked = true;
    this.weapons.ar.mag = this.weapons.ar.magSize;
    this.weapons.ar.reserve = 120;
    this.weapons.ar.cooldown = 0;
    this.weapons.m6d.unlocked = true;
    this.weapons.m6d.mag = this.weapons.m6d.magSize;
    this.weapons.m6d.reserve = 36;
    this.weapons.shotgun.unlocked = true;
    this.weapons.shotgun.mag = this.weapons.shotgun.magSize;
    this.weapons.shotgun.reserve = 24;
    this.weapons.plasma.unlocked = false;
    this.weapons.plasma.mag = this.weapons.plasma.magSize;
    this.weapons.plasma.reserve = 0;
    this.weapons.grenade.unlocked = false;
    this.weapons.grenade.mag = 0;
    this.weapons.grenade.reserve = 0;
    this.weapons.sniper.unlocked = false;
    this.weapons.sniper.mag = 0;
    this.weapons.sniper.reserve = 0;
    this.weapons.sniper.pumpTimer = 0;
    this.player.shield = GAME_CONFIG.player.maxShield;
    this.player.shieldRechargeTimer = 0;
    this.meleeCooldown = 0;
    this.collectedKeys = new Set();
    this.collectedJournalIds = new Set();
    this.#updateWeaponViewModelVisibility();
    this.#syncHudAmmo();
    this.#loadLevel(this.levelIndex);
    if (options.continueFromSave) {
      this.#tryLoadManualSave();
    }
    this.controls.lock();
  }

  #getSavedRunSummary() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      const difficultyKey = data.difficultyKey;
      const difficulty = DIFFICULTIES[difficultyKey];
      if (!difficulty?.allowManualSave) return null;
      const levelIndex = Math.max(0, Math.min(LEVELS.length - 1, Number(data.levelIndex) || 0));
      const label = `${difficulty.label} • Level ${levelIndex + 1}`;
      return { difficultyKey, levelIndex, label };
    } catch {
      return null;
    }
  }

  #clearLevel() {
    this.staticMeshes.length = 0;
    this.collisionBoxes.length = 0;
    this.flickerLights.length = 0;
    this.rotatingAlarmLights.length = 0;
    this.interactables.length = 0;
    this.doors.length = 0;
    this.pickups.length = 0;
    this.enemies.length = 0;
    for (const projectile of this.playerProjectiles) {
      if (projectile.mesh) this.levelGroup.remove(projectile.mesh);
    }
    this.playerProjectiles.length = 0;
    this.corpses.length = 0;
    this.anchors.length = 0;
    this.riftTimer = 0;
    this.riftSparkTimer = 0;
    this.ventBursts.length = 0;
    this.crates.length = 0;
    for (const chunk of this.gibChunks) {
      this.levelGroup.remove(chunk.mesh);
    }
    this.gibChunks.length = 0;
    for (const casing of this.shellCasings) {
      this.levelGroup.remove(casing.mesh);
      casing.mesh.geometry.dispose();
      casing.mesh.material.dispose();
    }
    this.shellCasings.length = 0;
    this.oneFrameLights.length = 0;
    this.broadcastScreens.length = 0;
    this.scriptedEvents.length = 0;
    this.trackerGhostBlips.length = 0;
    this.levelTime = 0;
    this.paStaticTimer = rand(30, 90);
    this.phoneRingTimer = 0;
    this.phoneActive = false;
    this.deferredCrawlerCount = 0;
    this.player.grabbedBy = null;
    this.player.grabMashMeter = 0;
    this.player.controlStunTimer = 0;
    this.player.knockbackVelocity.set(0, 0, 0);
    this.reloadTimer = 0;
    this.reloadTargetWeaponId = null;
    for (const timeoutId of this.reloadTimeouts) clearTimeout(timeoutId);
    this.reloadTimeouts.length = 0;

    this.audio?.stopRiftAmbience?.();
    this.levelTransitioning = false;
    this.deathCinematicTimer = 0;

    while (this.levelGroup.children.length > 0) {
      const child = this.levelGroup.children[0];
      child.traverse?.((obj) => {
        if (obj.geometry?.disposeBoundsTree) {
          obj.geometry.disposeBoundsTree();
        }
      });
      this.levelGroup.remove(child);
    }
  }

  #sideFromTo(fromRoom, toRoom) {
    const dx = toRoom.center.x - fromRoom.center.x;
    const dz = toRoom.center.z - fromRoom.center.z;
    if (Math.abs(dx) > Math.abs(dz)) {
      return dx > 0 ? "east" : "west";
    }
    return dz > 0 ? "north" : "south";
  }

  #getAuthoredRooms() {
    if (!Array.isArray(this.level.rooms) || this.level.rooms.length === 0) {
      throw new Error(`Level "${this.level.id}" is missing authored rooms.`);
    }
    if (this.level.roomCount && this.level.rooms.length !== this.level.roomCount) {
      throw new Error(`Level "${this.level.id}" roomCount does not match authored rooms length.`);
    }

    return this.level.rooms.map((room, idx) => ({
      center: new THREE.Vector3(room.x * ROOM_STEP, 0, room.z * ROOM_STEP),
      width: room.width ?? 12,
      depth: room.depth ?? 12,
      index: idx,
    }));
  }

  #loadLevel(index) {
    this.#clearLevel();
    this.levelIndex = index;
    this.level = LEVELS[index];
    this.levelTime = 0;
    this.paStaticTimer = rand(30, 90);
    this.phoneRingTimer = 0.6;
    this.phoneActive = this.levelIndex === 1;
    this.hud.setLevelLabel(this.level.name);
    this.hud.updateKeycards(this.collectedKeys);

    const tone = mapRoomTone(this.level.ambience);
    this.scene.background.setHex(0x0d131d);
    this.scene.fog.color.setHex(0x111927);
    this.scene.fog.near = 22;
    this.scene.fog.far = this.level.ambience === "clean" ? 100 : 86;

    if (this.hemiLight) this.scene.remove(this.hemiLight);
    this.hemiLight = new THREE.HemisphereLight(tone.sky, tone.ground, tone.hemiIntensity);
    this.scene.add(this.hemiLight);
    if (this.ambientLight) this.scene.remove(this.ambientLight);
    this.ambientLight = new THREE.AmbientLight(0xd6deea, tone.ambientIntensity || 0.3);
    this.scene.add(this.ambientLight);
    if (this.fillLight) this.scene.remove(this.fillLight);
    this.fillLight = new THREE.DirectionalLight(0xdde5f2, 1.0);
    this.fillLight.position.set(10, 16, 8);
    this.fillLight.castShadow = false;
    this.scene.add(this.fillLight);

    this.rooms = this.#getAuthoredRooms();

    this.#buildRoomTiles();
    this.#buildRoomsAndDoors(tone);
    this.#buildDecorativeDetails(tone);
    this.#spawnAmbientProps();
    this.#spawnPickups();
    this.#spawnEnemies();
    this.#setupScriptedEvents();
    if (this.level.finalAnchors) {
      this.#spawnAnchors();
    }
    this.#spawnCrates();
    this.#setPlayerSpawn();

    if (this.levelIndex === 3) {
      this.audio.startRiftAmbience();
    }

    // Always start new runs at Level 1 instead of restoring prior progress automatically.
    this.#spawnJournalPickups();
    this.#syncJournalHud();
    this.#autoSaveOnLevelLoad();
  }

  #setPlayerSpawn() {
    const spawn = this.rooms[0].center.clone();
    let lookTarget = null;
    if (this.rooms.length > 1) {
      const side = this.#sideFromTo(this.rooms[0], this.rooms[1]);
      if (side === "south") spawn.z += 1.5;
      if (side === "north") spawn.z -= 1.5;
      if (side === "east") spawn.x -= 1.5;
      if (side === "west") spawn.x += 1.5;
      lookTarget = this.rooms[1].center;
    } else {
      spawn.z += 1.5;
    }
    this.camera.position.set(spawn.x, GAME_CONFIG.player.eyeHeight, spawn.z);
    if (lookTarget) {
      this.camera.lookAt(lookTarget.x, GAME_CONFIG.player.eyeHeight, lookTarget.z);
    }
    this.player.lastPosition.copy(this.camera.position);
  }

  #buildRoomTiles() {
    const floorGeo = new THREE.BoxGeometry(4, 0.15, 4);
    const ceilGeo = new THREE.BoxGeometry(4, 0.15, 4);
    const floorMat = new THREE.MeshStandardMaterial(MATERIAL_PRESETS.floor);
    const ceilMat = new THREE.MeshStandardMaterial(MATERIAL_PRESETS.ceiling);

    const floorMatrices = [];
    const ceilMatrices = [];
    const matrix = new THREE.Matrix4();

    for (const room of this.rooms) {
      const halfW = room.width * 0.5;
      const halfD = room.depth * 0.5;
      for (let x = -halfW + 2; x <= halfW - 2 + 0.01; x += 4) {
        for (let z = -halfD + 2; z <= halfD - 2 + 0.01; z += 4) {
          matrix.makeTranslation(room.center.x + x, 0, room.center.z + z);
          floorMatrices.push(matrix.clone());
          matrix.makeTranslation(room.center.x + x, WALL_HEIGHT, room.center.z + z);
          ceilMatrices.push(matrix.clone());
        }
      }
    }

    const floorMesh = new THREE.InstancedMesh(floorGeo, floorMat, floorMatrices.length);
    const ceilMesh = new THREE.InstancedMesh(ceilGeo, ceilMat, ceilMatrices.length);
    floorMesh.receiveShadow = true;
    ceilMesh.receiveShadow = true;
    for (let i = 0; i < floorMatrices.length; i += 1) floorMesh.setMatrixAt(i, floorMatrices[i]);
    for (let i = 0; i < ceilMatrices.length; i += 1) ceilMesh.setMatrixAt(i, ceilMatrices[i]);
    this.levelGroup.add(floorMesh, ceilMesh);
  }

  #buildRoomsAndDoors(tone) {
    const wallMat = new THREE.MeshStandardMaterial({
      ...MATERIAL_PRESETS.wall,
      color: tone.wallColor ?? MATERIAL_PRESETS.wall.color,
    });
    const floorMat = new THREE.MeshStandardMaterial({
      ...MATERIAL_PRESETS.floor,
      color: tone.floorColor ?? MATERIAL_PRESETS.floor.color,
    });
    const ceilMat = new THREE.MeshStandardMaterial(MATERIAL_PRESETS.ceiling);
    const alienMat = new THREE.MeshStandardMaterial(MATERIAL_PRESETS.alien);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x353a44, metalness: 0.7, roughness: 0.5 });

    const lockedDoorMap = new Map(this.level.lockedDoors.map((door) => [door.room, door.color]));

    for (const room of this.rooms) {
      const hW = room.width * 0.5;
      const hD = room.depth * 0.5;
      const linkedOpenings = new Map();
      const registerLinkedOpening = (otherRoom) => {
        if (!otherRoom) return;
        const side = this.#sideFromTo(room, otherRoom);
        const openingCoord = (side === "north" || side === "south")
          ? (room.center.x + otherRoom.center.x) * 0.5
          : (room.center.z + otherRoom.center.z) * 0.5;
        linkedOpenings.set(side, openingCoord);
      };
      if (room.index > 0) registerLinkedOpening(this.rooms[room.index - 1]);
      if (room.index < this.rooms.length - 1) registerLinkedOpening(this.rooms[room.index + 1]);

      const buildHorizontalWall = (zPos, openingX = null) => {
        if (openingX == null) {
          this.#addWallSection(room.center.x, 1.5, zPos, room.width, WALL_HEIGHT, WALL_THICKNESS, wallMat);
          return;
        }
        const minX = room.center.x - hW;
        const maxX = room.center.x + hW;
        const halfDoor = DOOR_WIDTH * 0.5;
        const clampedOpening = THREE.MathUtils.clamp(openingX, minX + halfDoor, maxX - halfDoor);
        const leftW = clampedOpening - halfDoor - minX;
        const rightW = maxX - (clampedOpening + halfDoor);
        if (leftW > 0.05) {
          this.#addWallSection(minX + leftW * 0.5, 1.5, zPos, leftW, WALL_HEIGHT, WALL_THICKNESS, wallMat);
        }
        if (rightW > 0.05) {
          this.#addWallSection(clampedOpening + halfDoor + rightW * 0.5, 1.5, zPos, rightW, WALL_HEIGHT, WALL_THICKNESS, wallMat);
        }
      };

      const buildVerticalWall = (xPos, openingZ = null) => {
        if (openingZ == null) {
          this.#addWallSection(xPos, 1.5, room.center.z, WALL_THICKNESS, WALL_HEIGHT, room.depth, wallMat);
          return;
        }
        const minZ = room.center.z - hD;
        const maxZ = room.center.z + hD;
        const halfDoor = DOOR_WIDTH * 0.5;
        const clampedOpening = THREE.MathUtils.clamp(openingZ, minZ + halfDoor, maxZ - halfDoor);
        const bottomD = clampedOpening - halfDoor - minZ;
        const topD = maxZ - (clampedOpening + halfDoor);
        if (bottomD > 0.05) {
          this.#addWallSection(xPos, 1.5, minZ + bottomD * 0.5, WALL_THICKNESS, WALL_HEIGHT, bottomD, wallMat);
        }
        if (topD > 0.05) {
          this.#addWallSection(xPos, 1.5, clampedOpening + halfDoor + topD * 0.5, WALL_THICKNESS, WALL_HEIGHT, topD, wallMat);
        }
      };

      buildVerticalWall(room.center.x - hW, linkedOpenings.get("west") ?? null);
      buildVerticalWall(room.center.x + hW, linkedOpenings.get("east") ?? null);
      buildHorizontalWall(room.center.z + hD, linkedOpenings.get("north") ?? null);
      buildHorizontalWall(room.center.z - hD, linkedOpenings.get("south") ?? null);

      if (tone.infested && Math.random() < (this.level.ambience === "mixed" ? 0.4 : 0.8)) {
        const resinPatch = new THREE.Mesh(
          new THREE.BoxGeometry(rand(1.2, 2.4), rand(0.1, 0.2), rand(1.2, 2.6)),
          alienMat
        );
        resinPatch.position.set(room.center.x + rand(-hW + 1, hW - 1), rand(0.05, 0.15), room.center.z + rand(-hD + 1, hD - 1));
        resinPatch.castShadow = false;
        resinPatch.receiveShadow = false;
        this.levelGroup.add(resinPatch);
      }

      const strip = new THREE.RectAreaLight(tone.strip, tone.stripIntensity || 1.2, Math.min(6, room.width - 1.5), 0.35);
      strip.position.set(room.center.x, 2.85, room.center.z);
      // RectAreaLight emits along +Z; rotate so emission points downward (-Y).
      strip.rotation.x = Math.PI / 2;
      this.levelGroup.add(strip);
      if (tone.infested && Math.random() < 0.45) {
        this.flickerLights.push({ light: strip, timer: rand(0.2, 2.2), downTime: 0 });
      }

      // Visible ceiling light fixture housing
      const fixtureColor = new THREE.Color(tone.strip);
      const fixtureMat = new THREE.MeshStandardMaterial({
        color: 0x1a2030,
        emissive: fixtureColor,
        emissiveIntensity: 0.9,
        metalness: 0.4,
        roughness: 0.45,
      });
      const fixtureW = Math.min(5.8, room.width - 1.8);
      const fixture = new THREE.Mesh(new THREE.BoxGeometry(fixtureW, 0.06, 0.32), fixtureMat);
      fixture.position.set(room.center.x, WALL_HEIGHT - 0.04, room.center.z);
      this.levelGroup.add(fixture);
      // Fixture housing surround (dark casing)
      const casingMat = new THREE.MeshStandardMaterial({ color: 0x0d1220, metalness: 0.7, roughness: 0.4 });
      const casing = new THREE.Mesh(new THREE.BoxGeometry(fixtureW + 0.12, 0.1, 0.46), casingMat);
      casing.position.set(room.center.x, WALL_HEIGHT - 0.02, room.center.z);
      this.levelGroup.add(casing);

      // Volumetric-style light cone below each fixture (emissive cone mesh)
      if (!tone.infested || Math.random() < 0.6) {
        const coneH = 2.2;
        const coneR = Math.min(1.6, fixtureW * 0.5);
        const coneGeo = new THREE.ConeGeometry(coneR, coneH, 16, 1, true);
        const coneColor = new THREE.Color(tone.strip).multiplyScalar(0.55);
        const coneMat = new THREE.MeshBasicMaterial({
          color: coneColor,
          transparent: true,
          opacity: 0.045,
          side: THREE.BackSide,
          depthWrite: false,
        });
        const coneMesh = new THREE.Mesh(coneGeo, coneMat);
        coneMesh.position.set(room.center.x, WALL_HEIGHT - 0.08 - coneH * 0.5, room.center.z);
        coneMesh.renderOrder = 0;
        this.levelGroup.add(coneMesh);
      }

      if (tone.alarm && Math.random() < 0.45) {
        const alarm = new THREE.PointLight(0xff3020, 0.8, 10, 2);
        alarm.position.set(room.center.x + rand(-2.5, 2.5), 2.6, room.center.z);
        this.levelGroup.add(alarm);
        this.rotatingAlarmLights.push({ light: alarm, baseX: alarm.position.x, baseZ: alarm.position.z, phase: Math.random() * Math.PI * 2 });
      }
    }

    for (let i = 0; i < this.rooms.length - 1; i += 1) {
      const room = this.rooms[i];
      const nextRoom = this.rooms[i + 1];
      const side = this.#sideFromTo(room, nextRoom);

      let doorGeometry = new THREE.BoxGeometry(DOOR_WIDTH, WALL_HEIGHT, 0.2);
      let doorX = 0;
      let doorZ = 0;
      let panelX = 0;
      let panelZ = 0;

      if (side === "north" || side === "south") {
        const sign = side === "north" ? 1 : -1;
        const roomEdge = room.center.z + sign * room.depth * 0.5;
        const nextEdge = nextRoom.center.z - sign * nextRoom.depth * 0.5;
        doorX = (room.center.x + nextRoom.center.x) * 0.5;
        doorZ = (roomEdge + nextEdge) * 0.5;
        panelX = doorX + 1.1;
        panelZ = doorZ - sign * 0.2;
      } else {
        const sign = side === "east" ? 1 : -1;
        const roomEdge = room.center.x + sign * room.width * 0.5;
        const nextEdge = nextRoom.center.x - sign * nextRoom.width * 0.5;
        doorGeometry = new THREE.BoxGeometry(0.2, WALL_HEIGHT, DOOR_WIDTH);
        doorX = (roomEdge + nextEdge) * 0.5;
        doorZ = (room.center.z + nextRoom.center.z) * 0.5;
        panelX = doorX - sign * 0.2;
        panelZ = doorZ + 1.1;
      }

      const doorMesh = new THREE.Mesh(doorGeometry, doorMat);
      doorMesh.castShadow = true;
      doorMesh.receiveShadow = true;
      doorMesh.position.set(doorX, 1.5, doorZ);
      this.levelGroup.add(doorMesh);

      const reqKey = lockedDoorMap.get(i + 1) || null;
      const panelMaterial = new THREE.MeshStandardMaterial({
        color: 0x0f1216,
        emissive: reqKey ? GAME_CONFIG.keyColors[reqKey] : 0x224466,
        emissiveIntensity: reqKey ? 0.8 : 0.3,
        metalness: 0.4,
        roughness: 0.55,
      });
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, 0.15), panelMaterial);
      panel.position.set(panelX, 1.2, panelZ);
      this.levelGroup.add(panel);

      const door = new Door(doorMesh, panel, i + 1, reqKey);
      this.doors.push(door);

      this.interactables.push({
        mesh: panel,
        range: 2,
        prompt: reqKey ? `Press E - Use ${reqKey.toUpperCase()} keycard` : "Door control panel",
        onInteract: () => {
          if (door.open) return;
          if (door.locked && !this.collectedKeys.has(door.requiredKey)) return;
          door.locked = false;
          door.triggered = true;
        },
      });
    }

    for (let i = 0; i < this.rooms.length - 1; i += 1) {
      this.#addRoomConnector(this.rooms[i], this.rooms[i + 1], wallMat, floorMat, ceilMat);
    }
    this.#addOuterBoundary(wallMat);

    const ambienceSpawnCount = this.level.ambience === "clean" ? 1 : this.level.ambience === "mixed" ? 2 : 3;
    for (let i = 0; i < ambienceSpawnCount; i += 1) {
      const room = this.rooms[Math.max(1, Math.floor(rand(1, this.rooms.length - 1)))];
      const glow = new THREE.PointLight(0x6aaa50, 1.0, 8, 2);
      glow.position.set(room.center.x + rand(-2, 2), 1.1, room.center.z + rand(-2, 2));
      glow.castShadow = true;
      this.levelGroup.add(glow);
    }
  }

  #addWallSection(x, y, z, w, h, d, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.geometry.computeBoundsTree?.();
    this.levelGroup.add(mesh);
    this.staticMeshes.push(mesh);

    const box = new THREE.Box3(
      new THREE.Vector3(x - w * 0.5, y - h * 0.5, z - d * 0.5),
      new THREE.Vector3(x + w * 0.5, y + h * 0.5, z + d * 0.5)
    );
    this.collisionBoxes.push(box);
  }

  #addRoomConnector(fromRoom, toRoom, wallMat, floorMat, ceilMat) {
    const side = this.#sideFromTo(fromRoom, toRoom);
    const corridorWidth = 4;
    const halfCorr = corridorWidth * 0.5;

    if (side === "north" || side === "south") {
      const sign = side === "north" ? 1 : -1;
      const edgeA = fromRoom.center.z + sign * fromRoom.depth * 0.5;
      const edgeB = toRoom.center.z - sign * toRoom.depth * 0.5;
      const gapLen = Math.max(0, Math.abs(edgeB - edgeA));
      if (gapLen < 0.1) return;

      const centerX = (fromRoom.center.x + toRoom.center.x) * 0.5;
      const centerZ = (edgeA + edgeB) * 0.5;
      this.#addWallSection(centerX - halfCorr, 1.5, centerZ, WALL_THICKNESS, WALL_HEIGHT, gapLen, wallMat);
      this.#addWallSection(centerX + halfCorr, 1.5, centerZ, WALL_THICKNESS, WALL_HEIGHT, gapLen, wallMat);

      const floor = new THREE.Mesh(new THREE.BoxGeometry(corridorWidth, 0.15, gapLen), floorMat);
      floor.position.set(centerX, 0, centerZ);
      floor.receiveShadow = true;
      this.levelGroup.add(floor);

      const ceil = new THREE.Mesh(new THREE.BoxGeometry(corridorWidth, 0.15, gapLen), ceilMat);
      ceil.position.set(centerX, WALL_HEIGHT, centerZ);
      ceil.receiveShadow = true;
      this.levelGroup.add(ceil);
      return;
    }

    const sign = side === "east" ? 1 : -1;
    const edgeA = fromRoom.center.x + sign * fromRoom.width * 0.5;
    const edgeB = toRoom.center.x - sign * toRoom.width * 0.5;
    const gapLen = Math.max(0, Math.abs(edgeB - edgeA));
    if (gapLen < 0.1) return;

    const centerX = (edgeA + edgeB) * 0.5;
    const centerZ = (fromRoom.center.z + toRoom.center.z) * 0.5;
    this.#addWallSection(centerX, 1.5, centerZ - halfCorr, gapLen, WALL_HEIGHT, WALL_THICKNESS, wallMat);
    this.#addWallSection(centerX, 1.5, centerZ + halfCorr, gapLen, WALL_HEIGHT, WALL_THICKNESS, wallMat);

    const floor = new THREE.Mesh(new THREE.BoxGeometry(gapLen, 0.15, corridorWidth), floorMat);
    floor.position.set(centerX, 0, centerZ);
    floor.receiveShadow = true;
    this.levelGroup.add(floor);

    const ceil = new THREE.Mesh(new THREE.BoxGeometry(gapLen, 0.15, corridorWidth), ceilMat);
    ceil.position.set(centerX, WALL_HEIGHT, centerZ);
    ceil.receiveShadow = true;
    this.levelGroup.add(ceil);
  }

  #addOuterBoundary(wallMat) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const room of this.rooms) {
      minX = Math.min(minX, room.center.x - room.width * 0.5);
      maxX = Math.max(maxX, room.center.x + room.width * 0.5);
      minZ = Math.min(minZ, room.center.z - room.depth * 0.5);
      maxZ = Math.max(maxZ, room.center.z + room.depth * 0.5);
    }

    const margin = 6;
    const thickness = 0.6;
    const spanX = maxX - minX + margin * 2;
    const spanZ = maxZ - minZ + margin * 2;
    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;

    this.#addWallSection(minX - margin, 1.5, cz, thickness, WALL_HEIGHT, spanZ + thickness * 2, wallMat);
    this.#addWallSection(maxX + margin, 1.5, cz, thickness, WALL_HEIGHT, spanZ + thickness * 2, wallMat);
    this.#addWallSection(cx, 1.5, minZ - margin, spanX + thickness * 2, WALL_HEIGHT, thickness, wallMat);
    this.#addWallSection(cx, 1.5, maxZ + margin, spanX + thickness * 2, WALL_HEIGHT, thickness, wallMat);
  }

  #spawnPickups() {
    const ammoMat = new THREE.MeshStandardMaterial({
      color: 0xf0f6ff,
      emissive: 0xb7d8ff,
      emissiveIntensity: 0.35,
      metalness: 0.2,
      roughness: 0.35,
    });

    const medSmallMat = new THREE.MeshStandardMaterial({ color: 0x82d5a4, emissive: 0x1b5f38, emissiveIntensity: 0.35 });
    const medLargeMat = new THREE.MeshStandardMaterial({ color: 0xa7f0c2, emissive: 0x2b9a6a, emissiveIntensity: 0.45 });
    const keyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.3 });

    const keyRooms = new Map(this.level.keycards.map((k) => [k.room, k.color]));

    for (let i = 1; i < this.rooms.length; i += 1) {
      const room = this.rooms[i];

      if (keyRooms.has(i)) {
        const keyColor = keyRooms.get(i);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.1, 0.3), keyMat.clone());
        mesh.material.emissive = new THREE.Color(GAME_CONFIG.keyColors[keyColor]);
        mesh.material.emissiveIntensity = 0.8;
        mesh.position.set(room.center.x + rand(-1.5, 1.5), 0.85, room.center.z + rand(-1.5, 1.5));
        this.levelGroup.add(mesh);
        this.pickups.push(new Pickup(mesh, "keycard", 0, keyColor));
        continue;
      }

      if (Math.random() < 0.7 * this.difficulty.ammoPickupMultiplier) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.13, 0.4), ammoMat);
        mesh.position.set(room.center.x + rand(-2.5, 2.5), 0.75, room.center.z + rand(-2.5, 2.5));
        this.levelGroup.add(mesh);
        this.pickups.push(new Pickup(mesh, "ammo", 12));
      }

      const healthChance = 0.42 * this.difficulty.healthPickupMultiplier;
      if (Math.random() < healthChance) {
        const large = Math.random() < 0.2;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.25, 0.45), large ? medLargeMat : medSmallMat);
        mesh.position.set(room.center.x + rand(-2.3, 2.3), 0.75, room.center.z + rand(-2.3, 2.3));
        this.levelGroup.add(mesh);
        this.pickups.push(new Pickup(mesh, "health", large ? 50 : 20));
      }
    }

    const levelWeaponRoom = this.rooms[Math.floor(rand(2, this.rooms.length - 1))];
    if (Math.random() < 0.8 && !this.weapons.grenade.unlocked) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.58, 0.18, 0.18),
        new THREE.MeshStandardMaterial({ color: 0x5d5c5b, metalness: 0.8, roughness: 0.3 })
      );
      mesh.position.set(levelWeaponRoom.center.x + rand(-2, 2), 0.82, levelWeaponRoom.center.z + rand(-2, 2));
      this.levelGroup.add(mesh);
      this.pickups.push(new Pickup(mesh, "weapon", 0, null, "grenade"));
    }

    // Sniper rifle — one per level in a mid-to-late room
    if (this.rooms.length >= 5 && !this.weapons.sniper.unlocked && Math.random() < 0.7) {
      const sniperRoom = this.rooms[Math.max(3, Math.floor(rand(this.rooms.length * 0.55, this.rooms.length - 1)))];
      const sniperMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.72, 0.12, 0.18),
        new THREE.MeshStandardMaterial({
          color: 0x1a2030, emissive: 0x4dd8ff, emissiveIntensity: 0.55,
          metalness: 0.85, roughness: 0.2,
        })
      );
      sniperMesh.position.set(sniperRoom.center.x + rand(-2, 2), 0.82, sniperRoom.center.z + rand(-2, 2));
      this.levelGroup.add(sniperMesh);
      this.pickups.push(new Pickup(sniperMesh, "weapon", 0, null, "sniper"));
    }
  }

  #spawnJournalPickups() {
    const remaining = JOURNAL_ENTRIES.filter((e) => !this.collectedJournalIds.has(e.id));
    if (remaining.length === 0 || this.rooms.length < 2) return;

    const pickCount = Math.min(remaining.length, 2 + Math.floor(Math.random() * 3));
    const pool = [...remaining];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const padMat = new THREE.MeshStandardMaterial({
      color: 0x3a2e1a,
      emissive: 0xc9a227,
      emissiveIntensity: 0.35,
      metalness: 0.35,
      roughness: 0.55,
    });

    for (let i = 0; i < pickCount; i += 1) {
      const entry = pool[i];
      const room = this.rooms[Math.floor(rand(1, this.rooms.length))];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.32), padMat.clone());
      mesh.position.set(room.center.x + rand(-2.2, 2.2), 0.82, room.center.z + rand(-2.2, 2.2));
      mesh.rotation.y = rand(-Math.PI, Math.PI);
      this.levelGroup.add(mesh);
      this.pickups.push(new Pickup(mesh, "journal", 0, null, null, entry.id));
    }
  }

  #sortedCollectedJournals() {
    return JOURNAL_ENTRIES.filter((e) => this.collectedJournalIds.has(e.id)).sort((a, b) => a.order - b.order);
  }

  #syncJournalHud() {
    const total = getJournalTotalCount();
    this.hud.setJournalProgress(this.collectedJournalIds.size, total);
    this.hud.refreshJournalLog(this.#sortedCollectedJournals());
  }

  #buildDecorativeDetails(tone) {
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x050e18, emissive: 0x1a6aaa, emissiveIntensity: 0.55,
      metalness: 0.1, roughness: 0.6,
    });
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x252d38, metalness: 0.72, roughness: 0.38 });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x030a10, emissive: tone.infested ? 0x2a7a2a : 0x0a4a8a,
      emissiveIntensity: 0.45, metalness: 0.15, roughness: 0.65,
    });

    for (const room of this.rooms) {
      const hW = room.width * 0.5;
      const hD = room.depth * 0.5;
      const cx = room.center.x;
      const cz = room.center.z;

      // Floor perimeter trim strips (4 sides)
      const trimH = 0.04;
      const trimW = 0.18;
      // North and South strips
      for (const sign of [-1, 1]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(room.width - 0.4, trimH, trimW), trimMat.clone());
        strip.position.set(cx, trimH * 0.5, cz + sign * (hD - trimW * 0.5 - 0.05));
        this.levelGroup.add(strip);
      }
      // East and West strips
      for (const sign of [-1, 1]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(trimW, trimH, room.depth - 0.4), trimMat.clone());
        strip.position.set(cx + sign * (hW - trimW * 0.5 - 0.05), trimH * 0.5, cz);
        this.levelGroup.add(strip);
      }

      // Wall accent strips at waist height (0.85m) on all 4 walls
      const accentH = 0.06;
      const accentY = 0.88;
      const accentD = 0.06;
      // North wall
      const aN = new THREE.Mesh(new THREE.BoxGeometry(room.width - 0.5, accentH, accentD), accentMat.clone());
      aN.position.set(cx, accentY, cz + hD - 0.12);
      this.levelGroup.add(aN);
      // South wall
      const aS = aN.clone();
      aS.position.set(cx, accentY, cz - hD + 0.12);
      this.levelGroup.add(aS);
      // East wall
      const aE = new THREE.Mesh(new THREE.BoxGeometry(accentD, accentH, room.depth - 0.5), accentMat.clone());
      aE.position.set(cx + hW - 0.12, accentY, cz);
      this.levelGroup.add(aE);
      // West wall
      const aW = aE.clone();
      aW.position.set(cx - hW + 0.12, accentY, cz);
      this.levelGroup.add(aW);

      // Structural pillars in wider rooms
      if (room.width >= 14 || room.depth >= 14) {
        const pillarW = 0.28;
        const pillarH = WALL_HEIGHT;
        const inset = 1.4;
        for (const [px, pz] of [
          [cx - hW + inset, cz - hD + inset],
          [cx + hW - inset, cz - hD + inset],
          [cx - hW + inset, cz + hD - inset],
          [cx + hW - inset, cz + hD - inset],
        ]) {
          const pillar = new THREE.Mesh(new THREE.BoxGeometry(pillarW, pillarH, pillarW), pillarMat);
          pillar.position.set(px, pillarH * 0.5, pz);
          pillar.castShadow = true;
          pillar.receiveShadow = true;
          this.levelGroup.add(pillar);
          // Emissive stripe on pillar
          const stripe = new THREE.Mesh(new THREE.BoxGeometry(pillarW + 0.01, 0.08, pillarW + 0.01), trimMat.clone());
          stripe.position.set(px, 0.82, pz);
          this.levelGroup.add(stripe);
        }
      }
    }
  }

  #spawnEnemyMesh(type) {
    const addShadow = (obj) => {
      obj.castShadow = true;
      obj.receiveShadow = true;
      return obj;
    };

    const makeBiped = (palette, armored = false) => {
      const root = new THREE.Group();

      const skinMat = new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.9, metalness: 0.03 });
      const clothMat = new THREE.MeshStandardMaterial({ color: palette.cloth, roughness: 0.88, metalness: 0.05 });
      const armorMat = new THREE.MeshStandardMaterial({ color: palette.armor, roughness: 0.55, metalness: 0.55 });

      const pelvis = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.24), clothMat));
      pelvis.position.set(0, -0.18, 0);
      root.add(pelvis);

      const torso = addShadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.23, 0.52, 4, 8), clothMat));
      torso.position.set(0, 0.22, 0);
      torso.rotation.x = -0.08;
      root.add(torso);

      const head = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), skinMat));
      head.position.set(0, 0.82, -0.02);
      root.add(head);

      const jaw = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.12), skinMat));
      jaw.position.set(0, 0.73, 0.08);
      jaw.rotation.x = 0.2;
      root.add(jaw);

      const brow = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.055, 0.085), skinMat));
      brow.position.set(0, 0.89, 0.09);
      brow.rotation.x = -0.2;
      root.add(brow);

      const cheekL = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.09), skinMat));
      const cheekR = cheekL.clone();
      cheekL.position.set(-0.1, 0.78, 0.06);
      cheekR.position.set(0.1, 0.78, 0.06);
      root.add(cheekL, cheekR);

      // Glowing eyes
      const eyeEmissive = palette.eyeEmissive !== undefined ? palette.eyeEmissive : 0xff3300;
      const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a0000, emissive: eyeEmissive, emissiveIntensity: 1.6, metalness: 0, roughness: 1 });
      const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), eyeMat.clone());
      const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), eyeMat.clone());
      leftEye.position.set(-0.055, 0.84, 0.11);
      rightEye.position.set(0.055, 0.84, 0.11);
      root.add(leftEye, rightEye);

      const leftArm = addShadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.5, 3, 6), skinMat));
      const rightArm = leftArm.clone();
      leftArm.position.set(-0.26, 0.1, 0.02);
      rightArm.position.set(0.26, 0.1, 0.02);
      leftArm.rotation.z = 0.35;
      rightArm.rotation.z = -0.35;
      root.add(leftArm, rightArm);

      const leftHand = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.07), skinMat));
      const rightHand = leftHand.clone();
      leftHand.position.set(-0.34, -0.2, 0.06);
      rightHand.position.set(0.34, -0.2, 0.06);
      root.add(leftHand, rightHand);

      const leftLeg = addShadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.62, 4, 8), clothMat));
      const rightLeg = leftLeg.clone();
      leftLeg.position.set(-0.12, -0.6, 0);
      rightLeg.position.set(0.12, -0.6, 0);
      root.add(leftLeg, rightLeg);

      const leftBoot = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 0.22), clothMat));
      const rightBoot = leftBoot.clone();
      leftBoot.position.set(-0.12, -0.96, 0.06);
      rightBoot.position.set(0.12, -0.96, 0.06);
      root.add(leftBoot, rightBoot);

      const tearMat = new THREE.MeshStandardMaterial({ color: 0x251c18, roughness: 1.0, metalness: 0.0 });
      const chestTear = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.015), tearMat));
      chestTear.position.set(0.05, 0.2, 0.145);
      chestTear.rotation.z = 0.18;
      root.add(chestTear);

      if (armored) {
        const vest = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.45, 0.28), armorMat));
        vest.position.set(0, 0.2, 0.03);
        root.add(vest);
        const helmet = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.24), armorMat));
        helmet.position.set(0, 0.86, -0.02);
        root.add(helmet);

        const visor = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.03), new THREE.MeshStandardMaterial({
          color: 0x081018,
          emissive: 0xff5a00,
          emissiveIntensity: 0.55,
          roughness: 0.2,
          metalness: 0.85,
        })));
        visor.position.set(0, 0.86, 0.11);
        root.add(visor);
      }

      const toneShift = rand(-0.03, 0.03);
      root.traverse((obj) => {
        if (!obj.isMesh || !obj.material?.color) return;
        obj.material.color.offsetHSL(0, 0, toneShift);
      });

      return root;
    };

    if (type === "crawler") {
      const body = new THREE.Group();
      const torso = addShadow(new THREE.Mesh(
        new THREE.CapsuleGeometry(0.26, 0.85, 4, 8),
        new THREE.MeshStandardMaterial({
          color: 0x3f4a3c,
          emissive: 0xc27a28,
          emissiveIntensity: 0.28,
          roughness: 0.78,
          metalness: 0.1,
        })
      ));
      torso.position.set(0, 0.22, -0.05);
      torso.rotation.x = -0.45;
      body.add(torso);

      const neck = addShadow(new THREE.Mesh(
        new THREE.CapsuleGeometry(0.07, 0.25, 3, 6),
        new THREE.MeshStandardMaterial({ color: 0x4b5546, roughness: 0.82, metalness: 0.05 })
      ));
      neck.position.set(0, 0.72, -0.25);
      neck.rotation.x = -0.35;
      body.add(neck);

      const head = addShadow(new THREE.Mesh(
        new THREE.SphereGeometry(0.17, 10, 8),
        new THREE.MeshStandardMaterial({
          color: 0x515a4f,
          emissive: 0xd18b3a,
          emissiveIntensity: 0.3,
          roughness: 0.75,
          metalness: 0.08,
        })
      ));
      head.position.set(0, 0.95, -0.42);
      body.add(head);

      const lowerJaw = addShadow(new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.08, 0.13),
        new THREE.MeshStandardMaterial({ color: 0x5b6558, roughness: 0.78, metalness: 0.06 })
      ));
      lowerJaw.position.set(0, 0.88, -0.28);
      lowerJaw.rotation.x = 0.24;
      body.add(lowerJaw);

      const fangMat = new THREE.MeshStandardMaterial({ color: 0xd9cdb8, roughness: 0.95, metalness: 0.02 });
      for (const x of [-0.06, -0.025, 0.025, 0.06]) {
        const fang = addShadow(new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.055, 5), fangMat));
        fang.position.set(x, 0.86, -0.22);
        fang.rotation.x = Math.PI;
        body.add(fang);
      }

      const crawlerEyeMat = new THREE.MeshStandardMaterial({ color: 0x0d0800, emissive: 0xff8800, emissiveIntensity: 2.0, metalness: 0, roughness: 1 });
      const cEyeL = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 6), crawlerEyeMat.clone());
      const cEyeR = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 6), crawlerEyeMat.clone());
      cEyeL.position.set(-0.06, 0.97, -0.26);
      cEyeR.position.set(0.06, 0.97, -0.26);
      body.add(cEyeL, cEyeR);

      const armMat = new THREE.MeshStandardMaterial({ color: 0x414c3f, roughness: 0.88, metalness: 0.03 });
      const leftArm = addShadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.78, 3, 6), armMat));
      const rightArm = leftArm.clone();
      leftArm.position.set(-0.28, -0.02, -0.12);
      rightArm.position.set(0.28, -0.02, -0.12);
      leftArm.rotation.z = 0.52;
      rightArm.rotation.z = -0.52;
      body.add(leftArm, rightArm);

      const legMat = new THREE.MeshStandardMaterial({ color: 0x323b31, roughness: 0.9, metalness: 0.02 });
      const leftLeg = addShadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.62, 4, 8), legMat));
      const rightLeg = leftLeg.clone();
      leftLeg.position.set(-0.12, -0.58, 0.02);
      rightLeg.position.set(0.12, -0.58, 0.02);
      body.add(leftLeg, rightLeg);

      const spineMat = new THREE.MeshStandardMaterial({ color: 0x2b2317, emissive: 0x7a3d18, emissiveIntensity: 0.24, roughness: 0.7, metalness: 0.12 });
      for (let si = 0; si < 5; si += 1) {
        const spine = addShadow(new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 6), spineMat));
        spine.position.set(0, 0.48 - si * 0.14, -0.22 + si * 0.03);
        spine.rotation.x = -1.2;
        body.add(spine);
      }

      return body;
    }
    if (type === "brute") {
      const body = new THREE.Group();
      const torso = addShadow(new THREE.Mesh(
        new THREE.CapsuleGeometry(0.62, 1.2, 6, 12),
        new THREE.MeshStandardMaterial({
          color: 0x352c27,
          emissive: 0x5e3a16,
          emissiveIntensity: 0.15,
          roughness: 0.82,
          metalness: 0.18,
        })
      ));
      torso.position.y = 0.55;
      body.add(torso);

      const head = addShadow(new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0x3d332d, emissive: 0x42260f, emissiveIntensity: 0.12, roughness: 0.82, metalness: 0.08 })
      ));
      head.position.set(0, 1.35, -0.03);
      body.add(head);

      const jaw = addShadow(new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.1, 0.16),
        new THREE.MeshStandardMaterial({ color: 0x312823, roughness: 0.88, metalness: 0.1 })
      ));
      jaw.position.set(0, 1.2, 0.1);
      jaw.rotation.x = 0.2;
      body.add(jaw);

      const bruteEyeMat = new THREE.MeshStandardMaterial({ color: 0x1a0000, emissive: 0xff1100, emissiveIntensity: 2.4, metalness: 0, roughness: 1 });
      const bEyeL = new THREE.Mesh(new THREE.SphereGeometry(0.038, 6, 6), bruteEyeMat.clone());
      const bEyeR = new THREE.Mesh(new THREE.SphereGeometry(0.038, 6, 6), bruteEyeMat.clone());
      bEyeL.position.set(-0.09, 1.38, 0.18);
      bEyeR.position.set(0.09, 1.38, 0.18);
      body.add(bEyeL, bEyeR);

      const armMat = new THREE.MeshStandardMaterial({ color: 0x2f2a25, emissive: 0x3a220e, emissiveIntensity: 0.1, roughness: 0.72, metalness: 0.32 });
      const leftArm = addShadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.98, 4, 8), armMat));
      const rightArm = leftArm.clone();
      leftArm.position.set(-0.64, 0.45, 0.04);
      rightArm.position.set(0.64, 0.45, 0.04);
      leftArm.rotation.z = 0.08;
      rightArm.rotation.z = -0.08;
      body.add(leftArm, rightArm);

      const clawMat = new THREE.MeshStandardMaterial({ color: 0x1d1a17, roughness: 0.58, metalness: 0.55 });
      const leftClaw = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, 0.2), clawMat));
      const rightClaw = leftClaw.clone();
      leftClaw.position.set(-0.72, -0.12, 0.15);
      rightClaw.position.set(0.72, -0.12, 0.15);
      body.add(leftClaw, rightClaw);

      const legMat = new THREE.MeshStandardMaterial({ color: 0x2a2521, roughness: 0.86, metalness: 0.18 });
      const leftLeg = addShadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.82, 4, 8), legMat));
      const rightLeg = leftLeg.clone();
      leftLeg.position.set(-0.2, -0.55, 0);
      rightLeg.position.set(0.2, -0.55, 0);
      body.add(leftLeg, rightLeg);

      // Shoulder armor plates
      const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.85, roughness: 0.2 });
      const lShoulder = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.28), shoulderMat);
      const rShoulder = lShoulder.clone();
      lShoulder.position.set(-0.68, 0.62, 0);
      rShoulder.position.set(0.68, 0.62, 0);
      lShoulder.castShadow = true; rShoulder.castShadow = true;
      body.add(lShoulder, rShoulder);
      // Chest plate
      const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.52, 0.28), shoulderMat);
      chestPlate.position.set(0, 0.62, 0.08);
      chestPlate.castShadow = true;
      body.add(chestPlate);

      const backPlate = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.44, 0.22), shoulderMat);
      backPlate.position.set(0, 0.58, -0.2);
      backPlate.castShadow = true;
      body.add(backPlate);
      // Emissive veins on chest
      const veinMat = new THREE.MeshStandardMaterial({ color: 0x100000, emissive: 0xff2200, emissiveIntensity: 0.9, metalness: 0, roughness: 1 });
      const veinL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.38, 0.02), veinMat);
      const veinR = veinL.clone();
      veinL.position.set(-0.15, 0.62, 0.22);
      veinR.position.set(0.15, 0.62, 0.22);
      body.add(veinL, veinR);

      const hornMat = new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.8, metalness: 0.25 });
      const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.2, 7), hornMat);
      const hornR = hornL.clone();
      hornL.position.set(-0.18, 1.55, -0.12);
      hornR.position.set(0.18, 1.55, -0.12);
      hornL.rotation.x = -0.35;
      hornR.rotation.x = -0.35;
      body.add(hornL, hornR);

      return body;
    }
    if (type === "shamblerGuard") {
      return makeBiped(
        {
          skin: 0x5d646a,
          cloth: 0x2a3038,
          armor: 0x3c4652,
          eyeEmissive: 0xff6600,
        },
        true
      );
    }
    return makeBiped({
      skin: 0x7e878f,
      cloth: 0x4f5a66,
      armor: 0x4f5a66,
    });
  }

  #randomCombatRoomIndex() {
    if (this.rooms.length <= 1) return 0;
    return Math.floor(rand(1, this.rooms.length));
  }

  #isEnemySpawnPointClear(position, minDistance = 1.2) {
    const paddingCfg = GAME_CONFIG.gameplayTuning?.spawnSpacing?.enemyPadding;
    const defaultPadding = paddingCfg?.default ?? 0.65;
    const crawlerPadding = paddingCfg?.crawler ?? 0.55;
    const brutePadding = paddingCfg?.brute ?? 1.0;
    for (const enemy of this.enemies) {
      const enemyPadding = enemy.type === "brute" ? brutePadding : enemy.type === "crawler" ? crawlerPadding : defaultPadding;
      const requiredDistance = minDistance + enemyPadding;
      if (enemy.mesh.position.distanceToSquared(position) < requiredDistance * requiredDistance) {
        return false;
      }
    }
    if (this.camera?.position && this.camera.position.distanceToSquared(position) < 4) {
      return false;
    }
    return true;
  }

  #findEnemySpawnPoint(room, anchor = null, spread = 2.4, minDistance = 1.2) {
    const halfW = Math.max(0.7, room.width * 0.5 - 0.8);
    const halfD = Math.max(0.7, room.depth * 0.5 - 0.8);
    const minX = room.center.x - halfW;
    const maxX = room.center.x + halfW;
    const minZ = room.center.z - halfD;
    const maxZ = room.center.z + halfD;

    for (let i = 0; i < 28; i += 1) {
      const sx = anchor ? anchor.x + rand(-spread, spread) : room.center.x + rand(-halfW, halfW);
      const sz = anchor ? anchor.z + rand(-spread, spread) : room.center.z + rand(-halfD, halfD);
      const candidate = new THREE.Vector3(
        THREE.MathUtils.clamp(sx, minX, maxX),
        0,
        THREE.MathUtils.clamp(sz, minZ, maxZ)
      );
      if (this.#isEnemySpawnPointClear(candidate, minDistance)) {
        return candidate;
      }
    }

    const fallbackBase = anchor || room.center;
    let bestCandidate = null;
    let bestDistanceSq = -Infinity;
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2;
      const radius = 0.65 + Math.floor(i / 4) * 0.55;
      const candidate = new THREE.Vector3(
        THREE.MathUtils.clamp(fallbackBase.x + Math.cos(angle) * radius, minX, maxX),
        0,
        THREE.MathUtils.clamp(fallbackBase.z + Math.sin(angle) * radius, minZ, maxZ)
      );
      if (this.#isEnemySpawnPointClear(candidate, minDistance)) {
        return candidate;
      }

      let nearestEnemySq = Infinity;
      for (const enemy of this.enemies) {
        const distSq = enemy.mesh.position.distanceToSquared(candidate);
        if (distSq < nearestEnemySq) nearestEnemySq = distSq;
      }
      if (nearestEnemySq > bestDistanceSq) {
        bestDistanceSq = nearestEnemySq;
        bestCandidate = candidate;
      }
    }

    return bestCandidate || new THREE.Vector3(
      THREE.MathUtils.clamp(fallbackBase.x, minX, maxX),
      0,
      THREE.MathUtils.clamp(fallbackBase.z, minZ, maxZ)
    );
  }

  #resolveEnemySpawnOverlap(position, minSpacing = 0.32) {
    if (!this.enemies.length) return position;
    const resolved = position.clone();
    const minSpacingSq = minSpacing * minSpacing;

    for (let pass = 0; pass < 8; pass += 1) {
      let adjusted = false;
      for (const enemy of this.enemies) {
        TMP_V1.copy(resolved).sub(enemy.mesh.position);
        TMP_V1.y = 0;
        const distSq = TMP_V1.lengthSq();
        if (distSq >= minSpacingSq) continue;

        const dist = Math.sqrt(Math.max(distSq, 0.000001));
        const push = minSpacing - dist;
        if (dist <= 0.0001) {
          const randomAngle = rand(0, Math.PI * 2);
          resolved.x += Math.cos(randomAngle) * push;
          resolved.z += Math.sin(randomAngle) * push;
        } else {
          resolved.x += (TMP_V1.x / dist) * push;
          resolved.z += (TMP_V1.z / dist) * push;
        }
        adjusted = true;
      }
      if (!adjusted) break;
    }

    return resolved;
  }

  #spawnEnemyGroups(type, count, options = {}) {
    const minGroup = options.minGroup ?? 2;
    const maxGroup = options.maxGroup ?? 4;
    const spread = options.spread ?? 2.4;
    const minDistance = options.minDistance ?? 1.2;
    const spacingCfg = GAME_CONFIG.gameplayTuning?.spawnSpacing;
    const spacingScaleByDifficulty = spacingCfg?.spacingScaleByDifficulty;
    const spacingScale = spacingScaleByDifficulty?.[this.difficultyKey]
      ?? spacingScaleByDifficulty?.normal
      ?? 1.0;
    const bruteIntraGroup = spacingCfg?.intraGroupMultiplier?.brute ?? 1.35;
    const defaultIntraGroup = spacingCfg?.intraGroupMultiplier?.default ?? 1.2;
    const fallbackSpreadBonus = spacingCfg?.fallbackSpreadBonus ?? 0.8;
    const fallbackDistanceBonus = spacingCfg?.fallbackDistanceBonus ?? 0.15;
    let remaining = Math.max(0, count);

    while (remaining > 0) {
      const roomIndex = this.#randomCombatRoomIndex();
      const room = this.rooms[roomIndex];
      const maxRoll = Math.max(minGroup, maxGroup) + 1;
      const groupSize = Math.min(remaining, Math.max(1, Math.floor(rand(minGroup, maxRoll))));
      const anchor = this.#findEnemySpawnPoint(room, null, Math.max(1.4, spread), minDistance + 0.2);
      const groupPositions = [];
      const intraGroupDistance = minDistance * (type === "brute" ? bruteIntraGroup : defaultIntraGroup) * spacingScale;

      for (let i = 0; i < groupSize; i += 1) {
        let pos = null;
        for (let attempt = 0; attempt < 14; attempt += 1) {
          const candidate = this.#findEnemySpawnPoint(room, anchor, spread, minDistance * spacingScale);
          const tooCloseToGroup = groupPositions.some((existing) => existing.distanceToSquared(candidate) < intraGroupDistance * intraGroupDistance);
          if (!tooCloseToGroup) {
            pos = candidate;
            break;
          }
        }
        if (!pos) {
          pos = this.#findEnemySpawnPoint(room, anchor, spread + fallbackSpreadBonus, minDistance * spacingScale + fallbackDistanceBonus);
        }
        groupPositions.push(pos.clone());
        this.#spawnEnemyInstance(type, roomIndex, { position: pos });
      }
      remaining -= groupSize;
    }
  }

  #spawnEnemyInstance(type, roomIndex = null, options = {}) {
    const diffHp = this.difficulty.enemyHpMultiplier;
    const resolvedRoomIndex = roomIndex == null ? this.#randomCombatRoomIndex() : Math.max(0, Math.min(this.rooms.length - 1, roomIndex));
    const room = this.rooms[resolvedRoomIndex];
    const mesh = this.#spawnEnemyMesh(type);
    const y = type === "brute" ? 1.0 : 0.95;
    const minSpawnSpacingCfg = GAME_CONFIG.gameplayTuning?.spawnSpacing?.minSpawnSpacing;
    const requestedMinSpacing = options.minSpawnSpacing;
    const typeMinSpacing = requestedMinSpacing
      ?? (type === "brute"
        ? (minSpawnSpacingCfg?.brute ?? 0.85)
        : type === "crawler"
          ? (minSpawnSpacingCfg?.crawler ?? 0.34)
          : (minSpawnSpacingCfg?.default ?? 0.32));

    if (options.position) {
      const resolvedPos = this.#resolveEnemySpawnOverlap(options.position, typeMinSpacing);
      mesh.position.copy(resolvedPos);
      mesh.position.y = y;
    } else {
      const pos = this.#findEnemySpawnPoint(room, null, 2.8, 1.2);
      const resolvedPos = this.#resolveEnemySpawnOverlap(pos, typeMinSpacing);
      mesh.position.set(resolvedPos.x, y, resolvedPos.z);
    }
    this.levelGroup.add(mesh);

    const stats = GAME_CONFIG.enemyStats[type];
    const enemy = new Enemy(type, mesh, { ...stats, hp: Math.round(stats.hp * diffHp) }, resolvedRoomIndex);
    enemy.state = options.state || (type === "crawler" ? "ALERT" : "PATROL");
    enemy.lastKnownPlayerPos.copy(this.camera.position);
    if (options.guardRoomIndex != null) {
      enemy.guardRoomIndex = options.guardRoomIndex;
      enemy.lastKnownPlayerPos.copy(this.rooms[options.guardRoomIndex].center);
    }
    this.enemies.push(enemy);
    this.#resolveEnemyWallCollision(enemy);
    return enemy;
  }

  #spawnEnemies() {
    const deferredCrawlerCount = this.levelIndex === 0 ? Math.min(4, this.level.enemies.crawler || 0) : 0;
    this.#spawnEnemyGroups("shamblerLab", this.level.enemies.shamblerLab || 0, { minGroup: 3, maxGroup: 6, spread: 2.8, minDistance: 1.15 });
    this.#spawnEnemyGroups("shamblerGuard", this.level.enemies.shamblerGuard || 0, { minGroup: 2, maxGroup: 4, spread: 2.5, minDistance: 1.2 });
    this.#spawnEnemyGroups("crawler", (this.level.enemies.crawler || 0) - deferredCrawlerCount, { minGroup: 2, maxGroup: 5, spread: 2.35, minDistance: 1.05 });
    this.#spawnEnemyGroups("brute", this.level.enemies.brute || 0, { minGroup: 1, maxGroup: 2, spread: 2.2, minDistance: 1.75 });
    this.deferredCrawlerCount = deferredCrawlerCount;

    const bruteEnemies = this.enemies.filter((e) => e.type === "brute");
    for (let i = 0; i < bruteEnemies.length && i < this.level.keycards.length; i += 1) {
      const keyRoomIndex = this.level.keycards[i].room;
      const room = this.rooms[keyRoomIndex];
      const pos = this.#findEnemySpawnPoint(room, room.center, 1.6, 1.75);
      bruteEnemies[i].mesh.position.set(pos.x, 1.0, pos.z);
      bruteEnemies[i].roomIndex = keyRoomIndex;
      bruteEnemies[i].guardRoomIndex = keyRoomIndex;
    }

    if (this.levelIndex === 0) {
      const introSentinel = this.enemies.find((enemy) => enemy.type === "shamblerLab" || enemy.type === "shamblerGuard");
      if (introSentinel) {
        const room = this.rooms[Math.min(1, this.rooms.length - 1)];
        introSentinel.mesh.position.set(room.center.x + 1.6, 0.95, room.center.z + 1.2);
        introSentinel.state = "IDLE";
        introSentinel.isIntroSentinel = true;
        introSentinel.alertTimer = 0;
      }
    }
  }

  #spawnAnchors() {
    const room = this.rooms[this.rooms.length - 1];
    for (let i = 0; i < this.level.finalAnchors; i += 1) {
      const angle = (i / this.level.finalAnchors) * Math.PI * 2;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.4, 1.2, 12),
        new THREE.MeshStandardMaterial({
          color: 0x7087aa,
          emissive: 0x638ad1,
          emissiveIntensity: 1.2,
          roughness: 0.25,
          metalness: 0.15,
        })
      );
      mesh.position.set(room.center.x + Math.cos(angle) * 3, 0.7, room.center.z + Math.sin(angle) * 2.6);
      this.levelGroup.add(mesh);

      const light = new THREE.PointLight(0x8ab2ff, 1.4, 8, 2);
      light.position.copy(mesh.position).add(new THREE.Vector3(0, 0.9, 0));
      this.levelGroup.add(light);

      const anchor = new RiftAnchor(mesh, light);
      mesh.userData.anchorRef = anchor;
      this.anchors.push(anchor);
      this.interactables.push({
        mesh,
        range: 2.25,
        holdDuration: 2,
        prompt: "Hold E - Destroy Rift Anchor",
        onHold: (dt) => this.#updateAnchorHold(anchor, dt),
      });
    }

    const portal = new THREE.Mesh(
      new THREE.TorusGeometry(2.3, 0.45, 22, 64),
      new THREE.MeshStandardMaterial({
        color: 0xaad7ff,
        emissive: 0x9dd8ff,
        emissiveIntensity: 2.2,
        roughness: 0.1,
        metalness: 0.0,
      })
    );
    portal.rotation.x = Math.PI * 0.5;
    portal.position.set(room.center.x, 1.6, room.center.z - 0.5);
    this.levelGroup.add(portal);
    this.portalMesh = portal;

    // Inner energy disc — translucent swirling field
    const discMat = new THREE.MeshStandardMaterial({
      color: 0x3090ff,
      emissive: 0x2266cc,
      emissiveIntensity: 1.8,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.1, 48), discMat);
    disc.rotation.x = Math.PI * 0.5;
    disc.position.copy(portal.position);
    disc.renderOrder = 1;
    this.levelGroup.add(disc);
    this.portalDisc = disc;

    // Outer corona ring (slightly larger torus, additive-ish via high emissive)
    const coronaMat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0x44aaff,
      emissiveIntensity: 1.0,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const corona = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.22, 12, 64), coronaMat);
    corona.rotation.x = Math.PI * 0.5;
    corona.position.copy(portal.position);
    this.levelGroup.add(corona);
    this.portalCorona = corona;

    // Central point light for portal glow
    const portalLight = new THREE.PointLight(0x6699ff, 2.5, 12, 2);
    portalLight.position.copy(portal.position);
    this.levelGroup.add(portalLight);
    this.portalLight = portalLight;
  }

  #updateAnchorHold(anchor, dt) {
    if (anchor.destroyed) return;
    const aliveBrutes = this.enemies.filter((e) => e.type === "brute" && e.state !== "DEAD").length;
    if (aliveBrutes > 0) return;
    anchor.holdProgress += dt;
    if (anchor.holdProgress >= 2) {
      anchor.destroyed = true;
      anchor.mesh.material.emissiveIntensity = 0.1;
      anchor.pulseLight.intensity = 0;
      anchor.mesh.visible = false;
      const destroyed = this.anchors.filter((a) => a.destroyed).length;
      if (destroyed >= this.anchors.length) {
        this.#onWin();
      }
    }
  }

  #updateRiftEffects(dt) {
    if (!this.portalMesh) return;
    this.riftTimer += dt;
    const t = this.riftTimer;

    // Rotate portal ring slowly
    this.portalMesh.rotation.z = t * 0.22;

    // Pulse portal emissive
    const portalPulse = 1.8 + Math.sin(t * 2.8) * 0.6 + Math.sin(t * 5.1) * 0.25;
    this.portalMesh.material.emissiveIntensity = portalPulse;

    // Animate inner disc — scale breathe + color shift
    if (this.portalDisc) {
      const breathe = 1.0 + Math.sin(t * 1.6) * 0.06;
      this.portalDisc.scale.setScalar(breathe);
      // Shift emissive between blue and cyan
      const blend = (Math.sin(t * 0.9) + 1) * 0.5;
      this.portalDisc.material.emissive.setRGB(0.08 + blend * 0.05, 0.28 + blend * 0.15, 0.65 + blend * 0.3);
      this.portalDisc.material.opacity = 0.28 + Math.sin(t * 2.1) * 0.10;
      this.portalDisc.material.emissiveIntensity = 1.4 + Math.sin(t * 3.4) * 0.5;
    }

    // Rotate corona in opposite direction
    if (this.portalCorona) {
      this.portalCorona.rotation.z = -t * 0.14;
      this.portalCorona.material.emissiveIntensity = 0.7 + Math.sin(t * 4.0) * 0.35;
    }

    // Pulse portal point light
    if (this.portalLight) {
      this.portalLight.intensity = 2.2 + Math.sin(t * 3.2) * 0.8;
    }

    // Pulse each anchor light and emissive
    for (const anchor of this.anchors) {
      if (anchor.destroyed) continue;
      const phase = this.anchors.indexOf(anchor) * 1.1;
      anchor.pulseLight.intensity = 1.2 + Math.sin(t * 2.5 + phase) * 0.7;
      anchor.mesh.material.emissiveIntensity = 1.0 + Math.sin(t * 3.0 + phase) * 0.5;
    }

    // Spawn rift sparks from portal rim periodically
    this.riftSparkTimer -= dt;
    if (this.riftSparkTimer <= 0) {
      this.riftSparkTimer = 0.08 + Math.random() * 0.12;
      const angle = Math.random() * Math.PI * 2;
      const radius = 2.1 + (Math.random() - 0.5) * 0.6;
      const origin = this.portalMesh.position.clone().add(
        new THREE.Vector3(Math.cos(angle) * radius, Math.random() * 0.4 - 0.2, Math.sin(angle) * radius)
      );
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 2.5,
        Math.random() * 2.8 + 0.5,
        (Math.random() - 0.5) * 2.5
      );
      const sparkMat = new THREE.MeshStandardMaterial({
        color: 0x3399ff,
        emissive: 0x44aaff,
        emissiveIntensity: 3.0,
        metalness: 0,
        roughness: 1,
      });
      const sparkMesh = new THREE.Mesh(new THREE.SphereGeometry(0.025, 4, 4), sparkMat);
      sparkMesh.position.copy(origin);
      sparkMesh.frustumCulled = false;
      this.levelGroup.add(sparkMesh);
      this.sparkParticles.push({ mesh: sparkMesh, vel, ttl: 0.35 + Math.random() * 0.25 });
    }
  }

  #spawnCrates() {
    const crateGeo = new THREE.BoxGeometry(0.85, 0.85, 0.85);
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x4d545c, metalness: 0.2, roughness: 0.8 });
    const crateTransforms = [];
    const matrix = new THREE.Matrix4();
    const roomCount = Math.max(1, this.rooms.length - 2);
    const count = Math.min(24, roomCount * 2);

    for (let i = 0; i < count; i += 1) {
      const room = this.rooms[Math.floor(rand(1, this.rooms.length - 1))];
      const pos = new THREE.Vector3(room.center.x + rand(-2.6, 2.6), 0.45, room.center.z + rand(-2.6, 2.6));
      matrix.makeTranslation(pos.x, pos.y, pos.z);
      crateTransforms.push(matrix.clone());
      this.crates.push({
        pos,
        vel: new THREE.Vector3(),
        radius: 0.55,
      });
    }

    this.crateMesh = new THREE.InstancedMesh(crateGeo, crateMat, crateTransforms.length);
    this.crateMesh.castShadow = true;
    this.crateMesh.receiveShadow = true;
    for (let i = 0; i < crateTransforms.length; i += 1) {
      this.crateMesh.setMatrixAt(i, crateTransforms[i]);
    }
    this.levelGroup.add(this.crateMesh);
  }

  #spawnAmbientProps() {
    const deskMat = new THREE.MeshStandardMaterial({ color: 0x3f4752, metalness: 0.45, roughness: 0.72 });
    const lockerMat = new THREE.MeshStandardMaterial({ color: 0x515a64, metalness: 0.5, roughness: 0.68 });
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x101821, emissive: 0x57a3ff, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.3 });
    const mugMat = new THREE.MeshStandardMaterial({ color: 0xcfd6df, metalness: 0.15, roughness: 0.35 });
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x2c3440, metalness: 0.75, roughness: 0.45 });
    const pipeJointMat = new THREE.MeshStandardMaterial({ color: 0x1e2830, metalness: 0.8, roughness: 0.35 });
    const consoleMat = new THREE.MeshStandardMaterial({ color: 0x1e2630, metalness: 0.5, roughness: 0.6 });
    const consoleScreenMat = new THREE.MeshStandardMaterial({
      color: 0x040c14, emissive: 0x22cc88, emissiveIntensity: 0.5, metalness: 0.1, roughness: 0.5,
    });
    const rackMat = new THREE.MeshStandardMaterial({ color: 0x1e2428, metalness: 0.72, roughness: 0.42 });
    const rackIndicatorMat = new THREE.MeshStandardMaterial({ color: 0x001800, emissive: 0x00ff44, emissiveIntensity: 0.9, metalness: 0, roughness: 1 });
    const rackIndicatorRedMat = new THREE.MeshStandardMaterial({ color: 0x180000, emissive: 0xff2200, emissiveIntensity: 0.9, metalness: 0, roughness: 1 });
    const growthMat = new THREE.MeshStandardMaterial({ color: 0x1a2a10, emissive: 0x2a4a08, emissiveIntensity: 0.18, roughness: 1.0, metalness: 0 });
    const growthVeinMat = new THREE.MeshStandardMaterial({ color: 0x0a1408, emissive: 0x88cc00, emissiveIntensity: 0.35, roughness: 1.0, metalness: 0 });

    const isInfested = this.level.ambience === "infested" || this.level.ambience === "mixed";
    const isRift = this.levelIndex === 3;

    const propRooms = Math.max(3, Math.floor(this.rooms.length * 0.7));
    for (let i = 1; i < propRooms; i += 1) {
      const room = this.rooms[i];
      const hW = room.width * 0.5;
      const hD = room.depth * 0.5;
      const cx = room.center.x;
      const cz = room.center.z;

      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.75, 0.7), deskMat);
      desk.position.set(cx + rand(-2.5, 2.5), 0.4, cz + rand(-2, 2));
      this.levelGroup.add(desk);

      const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 12), mugMat);
      mug.position.set(desk.position.x + rand(-0.38, 0.38), 0.83, desk.position.z + rand(-0.18, 0.18));
      this.levelGroup.add(mug);

      const locker = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.9, 0.5), lockerMat);
      locker.position.set(cx + rand(-3.1, 3.1), 0.95, cz + rand(-3.5, 3.5));
      locker.rotation.y = rand(-0.18, 0.18);
      this.levelGroup.add(locker);

      if (Math.random() < 0.85) {
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.55), screenMat.clone());
        screen.position.set(cx + rand(-2.5, 2.5), 1.45, cz + rand(-2.5, 2.5));
        screen.rotation.y = rand(-Math.PI, Math.PI);
        this.levelGroup.add(screen);
        this.broadcastScreens.push({
          mesh: screen,
          baseIntensity: 0.35,
          timer: rand(1.2, 4.5),
          glitchTimer: 0,
        });
      }

      // Wall-mounted console terminal (added to a random wall)
      if (Math.random() < 0.65) {
        const wallSide = Math.floor(Math.random() * 4);
        const consoleBase = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.62, 0.18), consoleMat);
        let cx2 = cx, cz2 = cz, ry = 0;
        if (wallSide === 0) { cz2 = cz + hD - 0.15; ry = Math.PI; }
        else if (wallSide === 1) { cz2 = cz - hD + 0.15; ry = 0; }
        else if (wallSide === 2) { cx2 = cx + hW - 0.15; ry = -Math.PI * 0.5; }
        else { cx2 = cx - hW + 0.15; ry = Math.PI * 0.5; }
        consoleBase.position.set(cx2 + rand(-1.2, 1.2), 1.1, cz2 + rand(-1.2, 1.2));
        consoleBase.rotation.y = ry;
        this.levelGroup.add(consoleBase);
        const consoleScreen = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.42, 0.04), consoleScreenMat.clone());
        consoleScreen.position.copy(consoleBase.position);
        consoleScreen.position.y += 0.06;
        consoleScreen.rotation.y = ry;
        this.levelGroup.add(consoleScreen);
        this.broadcastScreens.push({
          mesh: consoleScreen,
          baseIntensity: 0.5,
          timer: rand(0.8, 3.5),
          glitchTimer: 0,
        });
      }

      // Server rack (stacked units with status LEDs) — in ~40% of rooms
      if (Math.random() < 0.40) {
        const rackH = 1.8;
        const rack = new THREE.Mesh(new THREE.BoxGeometry(0.55, rackH, 0.72), rackMat);
        rack.position.set(cx + rand(-hW * 0.6, hW * 0.6), rackH * 0.5, cz + rand(-hD * 0.6, hD * 0.6));
        rack.castShadow = true;
        this.levelGroup.add(rack);
        // Drive bays — stacked thin strips
        const unitCount = 4 + Math.floor(Math.random() * 4);
        for (let u = 0; u < unitCount; u += 1) {
          const unitY = rack.position.y - rackH * 0.45 + u * (rackH * 0.9 / unitCount);
          const unit = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.065, 0.68), rackMat.clone());
          unit.material.color.setHex(0x252d34);
          unit.position.set(rack.position.x, unitY, rack.position.z);
          this.levelGroup.add(unit);
          // Status LED
          const ledMat = Math.random() < 0.15 ? rackIndicatorRedMat : rackIndicatorMat;
          const led = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.01), ledMat);
          led.position.set(rack.position.x - 0.18, unitY + 0.014, rack.position.z - 0.34);
          this.levelGroup.add(led);
        }
      }

      // Alien growth clusters — only on infested/rift levels, ~50% of rooms
      if ((isInfested || isRift) && Math.random() < 0.50) {
        const clusterCount = 2 + Math.floor(Math.random() * 3);
        const anchor = new THREE.Vector3(cx + rand(-hW * 0.55, hW * 0.55), 0, cz + rand(-hD * 0.55, hD * 0.55));
        for (let g = 0; g < clusterCount; g += 1) {
          const gx = anchor.x + rand(-0.55, 0.55);
          const gz = anchor.z + rand(-0.55, 0.55);
          const sr = 0.12 + Math.random() * 0.22;
          const blob = new THREE.Mesh(new THREE.SphereGeometry(sr, 7, 6), growthMat.clone());
          blob.position.set(gx, sr * 0.55, gz);
          blob.scale.y = 0.55 + Math.random() * 0.6;
          this.levelGroup.add(blob);
          // Vein tendrils reaching up the wall
          if (Math.random() < 0.5) {
            const vein = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.032, 0.5 + Math.random() * 0.8, 5), growthVeinMat);
            vein.position.set(gx + rand(-0.08, 0.08), blob.position.y + 0.25, gz + rand(-0.08, 0.08));
            vein.rotation.z = rand(-0.4, 0.4);
            this.levelGroup.add(vein);
          }
        }
      }

      // Pipe cluster along ceiling of some rooms
      if (Math.random() < 0.55) {
        const pipeCount = 2 + Math.floor(Math.random() * 3);
        const pipeLen = room.width * 0.65;
        for (let p = 0; p < pipeCount; p += 1) {
          const r = 0.035 + Math.random() * 0.025;
          const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, pipeLen, 6), pipeMat);
          pipe.rotation.z = Math.PI * 0.5;
          pipe.position.set(cx + rand(-0.5, 0.5), 2.6 - p * 0.12, cz + rand(-hD * 0.35, hD * 0.35));
          this.levelGroup.add(pipe);
          // Pipe joints
          for (const jx of [cx - pipeLen * 0.48, cx + pipeLen * 0.48]) {
            const joint = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.018, r + 0.018, 0.07, 6), pipeJointMat);
            joint.rotation.z = Math.PI * 0.5;
            joint.position.set(jx, pipe.position.y, pipe.position.z);
            this.levelGroup.add(joint);
          }
        }
      }
    }
  }

  #setupScriptedEvents() {
    this.scriptedEvents.length = 0;
    this.trackerGhostBlips.length = 0;

    if (this.levelIndex === 0 && this.deferredCrawlerCount > 0) {
      const roomIndex = Math.min(2, this.rooms.length - 1);
      const room = this.rooms[roomIndex];
      const vent = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.9, 0.18),
        new THREE.MeshStandardMaterial({ color: 0x28303a, metalness: 0.6, roughness: 0.55 })
      );
      vent.position.set(room.center.x + room.width * 0.5 - 0.2, 1.2, room.center.z - 1.2);
      this.levelGroup.add(vent);
      this.ventBursts.push({ mesh: vent, roomIndex, burstDone: false });
      this.scriptedEvents.push({
        id: "l1-crawler-vent",
        type: "ventBurst",
        roomIndex,
        count: this.deferredCrawlerCount,
        timer: 8,
        chitterTimer: 0.6,
        done: false,
      });
    }

    if (this.levelIndex === 1) {
      this.scriptedEvents.push({
        id: "l2-arena",
        type: "arenaWave",
        roomIndex: Math.min(4, this.rooms.length - 2),
        prewarnDone: false,
        done: false,
      });
    }
  }

  #getNearestRoomIndex(position) {
    let bestIndex = 0;
    let bestDist = Infinity;
    for (const room of this.rooms) {
      const dist = room.center.distanceToSquared(position);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = room.index;
      }
    }
    return bestIndex;
  }

  /** True if player (XZ) is inside a room's floor footprint, inset from walls by `wallMargin`. */
  #playerInsideRoomFootprint(room, wallMargin = 0.6) {
    const p = this.camera.position;
    const halfW = Math.max(0.5, room.width * 0.5 - wallMargin);
    const halfD = Math.max(0.5, room.depth * 0.5 - wallMargin);
    return Math.abs(p.x - room.center.x) <= halfW && Math.abs(p.z - room.center.z) <= halfD;
  }

  #positionInsideRoomFootprint(position, room, wallMargin = 0.6) {
    const halfW = Math.max(0.5, room.width * 0.5 - wallMargin);
    const halfD = Math.max(0.5, room.depth * 0.5 - wallMargin);
    return Math.abs(position.x - room.center.x) <= halfW && Math.abs(position.z - room.center.z) <= halfD;
  }

  #faceTargetFlat(enemy, targetPosition, roll = 0) {
    const dir = TMP_V3.copy(targetPosition).sub(enemy.mesh.position);
    dir.y = 0;
    if (dir.lengthSq() < 0.0001) return;
    const yaw = Math.atan2(dir.x, dir.z);
    enemy.mesh.rotation.set(0, yaw, roll);
  }

  #emitTrackerGhostBlips(count, roomIndex, duration = 2.3) {
    const room = this.rooms[Math.max(0, Math.min(this.rooms.length - 1, roomIndex))];
    if (!room) return;
    const playerPos = this.camera.position;
    this.camera.getWorldDirection(TMP_V1);
    const playerYaw = Math.atan2(TMP_V1.x, TMP_V1.z);

    for (let i = 0; i < count; i += 1) {
      const fakePos = room.center.clone().add(new THREE.Vector3(rand(-2.4, 2.4), 0, rand(-2.4, 2.4)));
      const offset = fakePos.sub(playerPos);
      offset.y = 0;
      const dist = offset.length();
      const norm = clamp01(dist / this.difficulty.motionTrackerRange);
      const yaw = Math.atan2(offset.x, offset.z) - playerYaw;
      this.trackerGhostBlips.push({
        x: Math.sin(yaw) * norm,
        y: -Math.cos(yaw) * norm,
        ttl: duration + rand(-0.5, 0.4),
      });
    }
  }

  #processScriptedEvents(dt) {
    const playerRoom = this.#getNearestRoomIndex(this.camera.position);

    for (const event of this.scriptedEvents) {
      if (event.done) continue;

      if (event.type === "ventBurst") {
        event.timer -= dt;
        event.chitterTimer -= dt;
        if (event.chitterTimer <= 0) {
          this.audio.playCrawlerChitter();
          event.chitterTimer = rand(0.9, 1.8);
        }
        if (event.timer <= 0) {
          const room = this.rooms[event.roomIndex];
          const ventInfo = this.ventBursts.find((item) => item.roomIndex === event.roomIndex && !item.burstDone);
          if (ventInfo) {
            ventInfo.burstDone = true;
            ventInfo.mesh.visible = false;
            const flash = new THREE.PointLight(0xffe2a0, 1.4, 5, 2);
            flash.position.copy(ventInfo.mesh.position);
            this.levelGroup.add(flash);
            this.oneFrameLights.push(flash);
          }
          const ventAnchor = room.center.clone().add(new THREE.Vector3(room.width * 0.5 - 1.3, 0, -1.2));
          for (let i = 0; i < event.count; i += 1) {
            const pos = this.#findEnemySpawnPoint(room, ventAnchor, 1.8, 1.0);
            this.#spawnEnemyInstance("crawler", event.roomIndex, { state: "ALERT", position: pos });
          }
          this.#emitTrackerGhostBlips(4, event.roomIndex, 1.8);
          event.done = true;
        }
      } else if (event.type === "arenaWave") {
        if (!event.prewarnDone && playerRoom >= event.roomIndex - 1) {
          event.prewarnDone = true;
          this.#emitTrackerGhostBlips(6, event.roomIndex, 2.4);
        }
        if (playerRoom >= event.roomIndex) {
          const room = this.rooms[event.roomIndex];
          const brutePos = this.#findEnemySpawnPoint(room, room.center.clone().add(new THREE.Vector3(0, 0, -0.8)), 1.1, 1.75);
          this.#spawnEnemyInstance("brute", event.roomIndex, {
            state: "ALERT",
            position: brutePos,
            guardRoomIndex: event.roomIndex,
          });
          const shamblerAnchor = this.#findEnemySpawnPoint(room, room.center, 2.4, 1.2);
          for (let i = 0; i < 5; i += 1) {
            const type = i < 3 ? "shamblerLab" : "shamblerGuard";
            const pos = this.#findEnemySpawnPoint(room, shamblerAnchor, 2.6, 1.1);
            this.#spawnEnemyInstance(type, event.roomIndex, {
              state: "ALERT",
              position: pos,
            });
          }
          this.audio.playShamblerMoan();
          event.done = true;
        }
      }
    }
  }

  #updateAmbientAudio(dt) {
    this.paStaticTimer -= dt;
    if (this.paStaticTimer <= 0) {
      this.audio.playPAStatic();
      this.paStaticTimer = rand(30, 90);
    }

    if (this.phoneActive) {
      this.phoneRingTimer -= dt;
      if (this.phoneRingTimer <= 0) {
        this.audio.playPhoneRing();
        this.phoneRingTimer = 1.8;
      }
    }
  }

  #updateWeaponViewModelVisibility() {
    if (!this.weaponViewModels) return;
    const id = this.currentWeaponId;
    if (this.weaponViewModels.ar) this.weaponViewModels.ar.visible = id === "ar";
    if (this.weaponViewModels.m6d) this.weaponViewModels.m6d.visible = id === "m6d";
    if (this.weaponViewModels.shotgun) this.weaponViewModels.shotgun.visible = id === "shotgun";
    if (this.weaponViewModels.sniper) this.weaponViewModels.sniper.visible = id === "sniper";
    if (this.weaponViewModels.plasma) this.weaponViewModels.plasma.visible = id === "plasma";
    if (this.weaponViewModels.grenade) this.weaponViewModels.grenade.visible = id === "grenade";
  }

  #switchWeapon(id) {
    if (!this.weapons[id]?.unlocked) return;
    if (id === this.currentWeaponId) return;
    this.weaponSwitchAnim = { t: 0.0, fromId: this.currentWeaponId };
    this.reloadAnim.active = false;
    if (id !== "grenade") { this.grenadeCylAngle = 0; this.grenadeCylTargetAngle = 0; }
    this.currentWeaponId = id;
    if (!this.weapons[id]?.canAds) {
      this.player.ads = false;
      this.input.adsHeld = false;
    }
    this.hud?.setSniperScope(false);
    this.#updateWeaponViewModelVisibility();
    this.#syncHudAmmo();
  }

  #setAds(active) {
    if (!this.weapons[this.currentWeaponId]?.canAds) {
      this.player.ads = false;
      this.hud?.setSniperScope(false);
      return;
    }
    this.player.ads = active;
    const isSniperAds = active && this.currentWeaponId === "sniper";
    this.hud?.setSniperScope(isSniperAds);
    if (active && this.reloadTimer > 0) {
      this.#startReload(true);
    }
  }

  #startReload(forceRestart = false) {
    const weapon = this.weapons[this.currentWeaponId];
    if (!weapon) return;
    if (weapon.id === "grenade") return;
    if (weapon.id === "sniper" && weapon.pumpTimer > 0) return;
    if (weapon.mag >= weapon.magSize && !forceRestart) return;
    if (weapon.reserve <= 0) return;
    if (this.reloadTimer > 0 && !forceRestart) return;

    this.reloadTargetWeaponId = weapon.id;
    if (weapon.id === "shotgun") {
      const t = weapon.reloadTime || 0.5;
      this.reloadTimer = t;
      for (const timeoutId of this.reloadTimeouts) clearTimeout(timeoutId);
      this.reloadTimeouts.length = 0;
      this.audio.playReloadPhase(1, weapon.id);
      this.reloadAnim = { active: true, t: 0, totalTime: t, weaponId: weapon.id };
      return;
    }

    const t = weapon.reloadTime || 1.6;
    this.reloadTimer = t;
    for (const timeoutId of this.reloadTimeouts) clearTimeout(timeoutId);
    this.reloadTimeouts.length = 0;

    const wid = weapon.id;
    // Adjust phase timing for plasma (slower cell swap) and sniper (deliberate bolt)
    const p2delay = wid === "plasma" ? 450 : wid === "sniper" ? 500 : 300;
    const p3delay = wid === "plasma" ? 1200 : wid === "sniper" ? 1300 : 1100;
    this.reloadTimeouts.push(setTimeout(() => this.audio.playReloadPhase(1, wid), 0));
    this.reloadTimeouts.push(setTimeout(() => this.audio.playReloadPhase(2, wid), p2delay));
    this.reloadTimeouts.push(setTimeout(() => this.audio.playReloadPhase(3, wid), p3delay));
    this.reloadAnim = { active: true, t: 0, totalTime: t, weaponId: weapon.id };
  }

  #finishReload() {
    const weaponId = this.reloadTargetWeaponId || this.currentWeaponId;
    const weapon = this.weapons[weaponId];
    if (!weapon || weapon.id === "grenade") {
      this.reloadTargetWeaponId = null;
      return;
    }
    if (weapon.id === "sniper") {
      weapon.pumpTimer = 0;
    }
    if (weapon.id === "shotgun") {
      if (weapon.mag < weapon.magSize && weapon.reserve > 0) {
        weapon.mag += 1;
        weapon.reserve -= 1;
      }
      this.reloadTargetWeaponId = null;
      this.reloadAnim.active = false;
      this.#syncHudAmmo();
      return;
    }
    const need = weapon.magSize - weapon.mag;
    const taken = Math.min(need, weapon.reserve);
    weapon.mag += taken;
    weapon.reserve -= taken;
    this.reloadTargetWeaponId = null;
    this.reloadAnim.active = false;
    this.#syncHudAmmo();
  }

  #tryFireClick() {
    if (this.reloadTimer > 0) return;
    if (this.fireCooldown > 0) return;
    const weapon = this.weapons[this.currentWeaponId];
    if (!weapon || !weapon.unlocked) return;

    if (weapon.id === "ar") { this.#fireAssaultRifle(); return; }
    if (weapon.id === "plasma") { this.#queuePlasmaBurst(); return; }
    if (weapon.id === "grenade") { this.#fireGrenade(); return; }
    if (weapon.id === "shotgun") { this.#fireShotgun(); return; }
    if (weapon.id === "sniper") { this.#fireSniper(); return; }
    this.#fireM6D();
  }

  #queuePlasmaBurst() {
    const weapon = this.weapons.plasma;
    if (weapon.cooldown > 0) return;
    if (weapon.burstShotsQueued > 0) return;
    if (weapon.mag <= 0) return;
    weapon.burstShotsQueued = weapon.burstCount;
    weapon.burstIntervalTimer = 0;
    weapon.burstResetTimer = weapon.burstResetDelay;
  }

  #fireAssaultRifle() {
    const weapon = this.weapons.ar;
    if (weapon.mag <= 0) {
      this.audio.playAREmpty();
      return;
    }
    weapon.mag -= 1;
    this.fireCooldown = weapon.fireInterval;
    this.stats.shots += 1;
    this.audio.playARFire();
    this.muzzleFlashPending = true;
    this.#triggerCameraShake(0.008, 0.06);
    this.#applyRecoil(0.62, {
      lateralKick: rand(-0.005, 0.004),
      rollKickDeg: rand(-1.6, 1.6),
      snap: 1.15,
      recover: 1.0,
    });
    this.#ejectShellCasing("rifle");

    const hit = this.#doHitscanShot(weapon);
    if (hit) {
      this.stats.hits += 1;
      this.audio.playHitConfirm();
    }
    this.#syncHudAmmo();
  }

  #fireM6D() {
    const weapon = this.weapons.m6d;
    if (weapon.mag <= 0) {
      this.audio.playM6DEmpty();
      return;
    }
    weapon.mag -= 1;
    this.fireCooldown = weapon.fireInterval;
    this.stats.shots += 1;
    this.audio.playM6DFire();
    this.muzzleFlashPending = true;
    this.#triggerCameraShake(0.014, 0.08);
    this.#applyRecoil(1.18, {
      lateralKick: rand(0.003, 0.008),
      rollKickDeg: rand(1.1, 2.2),
      snap: 1.2,
      recover: 0.95,
    });
    this.#ejectShellCasing("pistol");

    const hit = this.#doHitscanShot(weapon);
    if (hit) {
      this.stats.hits += 1;
      this.audio.playHitConfirm();
    }
    this.#syncHudAmmo();
  }

  #fireShotgun() {
    const weapon = this.weapons.shotgun;
    if (weapon.mag <= 0) {
      this.audio.playShotgunEmpty();
      return;
    }
    weapon.mag -= 1;
    this.fireCooldown = weapon.fireInterval;
    this.stats.shots += 1;
    this.audio.playShotgunFire();
    this.muzzleFlashPending = true;
    this.#triggerCameraShake(0.032, 0.14);
    this.#applyRecoil(2.05, {
      lateralKick: rand(-0.008, 0.008),
      rollKickDeg: rand(-2.8, 2.8),
      snap: 1.35,
      recover: 0.85,
    });
    this.#ejectShellCasing("shotgun");

    let hitCount = 0;
    for (let i = 0; i < (weapon.pellets || 8); i += 1) {
      const hit = this.#doHitscanShot(weapon);
      if (hit) hitCount += 1;
    }
    if (hitCount > 0) {
      this.stats.hits += hitCount;
      this.audio.playHitConfirm();
    }
    this.#syncHudAmmo();
  }

  #fireGrenade() {
    const weapon = this.weapons.grenade;
    if (weapon.mag <= 0) return;
    if (weapon.pumpTimer > 0) return;
    weapon.mag -= 1;
    weapon.pumpTimer = weapon.pumpTime;
    this.fireCooldown = 0.1;
    this.audio.playGrenadeLaunch();
    this.grenadeCylTargetAngle += (Math.PI * 2) / 6;
    this.stats.shots += 1;

    this.camera.getWorldDirection(TMP_V1);
    const spawnPos = this.camera.position.clone().add(TMP_V1.clone().multiplyScalar(0.7));
    const velocity = TMP_V1.clone().multiplyScalar(weapon.projectileSpeed).add(new THREE.Vector3(0, 1.2, 0));
    const grenadeMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 10, 10),
      new THREE.MeshStandardMaterial({
        color: 0x3a3f46,
        emissive: 0xff6a1a,
        emissiveIntensity: 0.9,
        metalness: 0.45,
        roughness: 0.35,
      })
    );
    grenadeMesh.position.copy(spawnPos);
    this.levelGroup.add(grenadeMesh);
    this.playerProjectiles.push({
      kind: "grenade",
      pos: spawnPos,
      vel: velocity,
      ttl: 3.5,
      radius: 0.12,
      mesh: grenadeMesh,
    });
    this.#syncHudAmmo();
  }

  #updatePlasma(dt) {
    const weapon = this.weapons.plasma;
    if (!weapon.unlocked) return;
    weapon.cooldown = Math.max(0, weapon.cooldown - dt);
    weapon.burstResetTimer = Math.max(0, weapon.burstResetTimer - dt);

    if (this.currentWeaponId === "plasma" && this.input.fireHeld && this.reloadTimer <= 0) {
      if (weapon.burstShotsQueued === 0 && weapon.cooldown <= 0) {
        this.#queuePlasmaBurst();
      }
    }

    if (weapon.burstShotsQueued > 0) {
      weapon.burstIntervalTimer -= dt;
      if (weapon.burstIntervalTimer <= 0) {
        if (weapon.mag <= 0 || weapon.cooldown > 0) {
          weapon.burstShotsQueued = 0;
          return;
        }
        weapon.mag -= 1;
        weapon.burstShotsQueued -= 1;
        weapon.burstIntervalTimer = weapon.burstInterval;
        weapon.overheat += 1;
        this.stats.shots += 1;
        this.audio.playPlasmaFire();
        this.plasmaRingPulse = 0.3; // stronger ring flash on fire
        this.muzzleFlashPending = true;
        this.#triggerCameraShake(0.012, 0.08);
        this.#applyRecoil(1.1);

        const hit = this.#doHitscanShot(weapon);
        if (hit) this.stats.hits += 1;

        if (weapon.overheat >= weapon.overheatThreshold) {
          weapon.cooldown = weapon.cooldown || GAME_CONFIG.weapons.plasma.cooldown;
          weapon.overheat = 0;
          weapon.burstShotsQueued = 0;
          this.audio.playPlasmaOverheat();
          this.plasmaRingPulse = 0.55; // longer flash on overheat
        }
        this.#syncHudAmmo();
      }
    }

    if (weapon.burstResetTimer <= 0 && weapon.burstShotsQueued === 0) {
      weapon.overheat = Math.max(0, weapon.overheat - dt * 16);
    }
  }

  #doHitscanShot(weapon) {
    this.camera.getWorldDirection(TMP_V1);
    const spread = THREE.MathUtils.degToRad(this.player.ads ? weapon.adsSpreadDeg || 0 : weapon.hipSpreadDeg || 0);
    if (spread > 0) {
      TMP_V2.set(rand(-spread, spread), rand(-spread, spread), 0);
      TMP_V1.add(TMP_V2).normalize();
    }

    const rayOrigin = this.camera.position.clone();
    const ray = new THREE.Ray(rayOrigin, TMP_V1.clone());
    const raycaster = new THREE.Raycaster(rayOrigin, TMP_V1, 0.01, 120);
    let nearestEnemy = null;
    let nearestEnemyDist = Infinity;
    let hitPoint = null;

    for (const enemy of this.enemies) {
      if (enemy.state === "DEAD") continue;
      const enemyHit = raycaster.intersectObject(enemy.mesh, true)[0];
      if (!enemyHit) continue;
      const dist = enemyHit.distance;
      if (dist < nearestEnemyDist) {
        nearestEnemyDist = dist;
        nearestEnemy = enemy;
        hitPoint = enemyHit.point.clone();
      }
    }

    const wallHit = raycaster.intersectObjects(this.staticMeshes, false)[0];
    let wallDist = wallHit ? wallHit.distance : Infinity;
    for (const door of this.doors) {
      if (door.openAmount >= 0.98) continue;
      const hit = raycaster.intersectObject(door.mesh, false)[0];
      if (hit) wallDist = Math.min(wallDist, hit.distance);
    }

    if (!nearestEnemy || nearestEnemyDist > wallDist) {
      if (wallHit) {
        this.#spawnImpactSparks(wallHit.point);
        this.#spawnBulletHole(wallHit.point, wallHit.face?.normal ?? new THREE.Vector3(0, 1, 0));
      }
      return false;
    }

    const baseDamage = weapon.damage || 0;
    const distance = nearestEnemyDist;
    const damage = (weapon.falloffStart != null && weapon.falloffEnd != null)
      ? damageWithFalloff(baseDamage, distance, weapon.falloffStart, weapon.falloffEnd, weapon.falloffMinMultiplier)
      : baseDamage;
    const hitLocation = this.#classifyEnemyHitLocation(nearestEnemy, hitPoint);
    const locationMultiplier = this.#getEnemyHitLocationMultiplier(nearestEnemy, hitLocation);
    this.#damageEnemy(nearestEnemy, damage * locationMultiplier, TMP_V1, {
      headshot: hitLocation === "head",
      hitLocation,
      locationMultiplier,
      hitPoint: hitPoint.clone(),
      weaponId: weapon.id,
      distance,
    });
    return true;
  }

  #classifyEnemyHitLocation(enemy, hitPoint) {
    TMP_V2.copy(hitPoint);
    enemy.mesh.worldToLocal(TMP_V2);
    const p = TMP_V2;
    const absX = Math.abs(p.x);

    if (enemy.type === "crawler") {
      if (p.y > 0.72 || (p.y > 0.5 && p.z < -0.2)) return "head";
      if (p.y > 0.56 && p.z < -0.12) return "neck";
      if (p.y < -0.34) return "leg";
      if (absX > 0.22 && p.y > -0.08 && p.y < 0.48) return "arm";
      return p.y > 0.2 ? "upperTorso" : "lowerTorso";
    }

    if (enemy.type === "brute") {
      if (p.y > 1.12) return "head";
      if (p.y > 0.95) return "neck";
      if (p.y < -0.18) return "leg";
      if (absX > 0.5 && p.y > -0.05 && p.y < 1.02) return "arm";
      return p.y > 0.42 ? "upperTorso" : "lowerTorso";
    }

    if (p.y > 0.64) return "head";
    if (p.y > 0.5) return "neck";
    if (p.y < -0.42) return "leg";
    if (absX > 0.22 && p.y > -0.12 && p.y < 0.52) return "arm";
    return p.y > 0.18 ? "upperTorso" : "lowerTorso";
  }

  #getEnemyHitLocationMultiplier(enemy, location) {
    const base = {
      head: 1.75,
      neck: 1.35,
      upperTorso: 1.0,
      lowerTorso: 0.9,
      arm: 0.72,
      leg: 0.68,
    };
    const tuning = GAME_CONFIG.gameplayTuning?.locationalDamage;
    const tuned = tuning?.multipliers?.[location];
    const perType = tuning?.perType?.[enemy.type]?.[location];
    return perType ?? tuned ?? base[location] ?? 1.0;
  }

  #damageEnemy(enemy, amount, shotDirection = null, hitMeta = null) {
    if (enemy.state === "DEAD") return;
    enemy.hp -= amount;
    // Hit flash
    enemy.hitFlashTimer = 0.12;
    // Hit splatter visual
    const splatColor = enemy.type === "brute" ? 0x4a0000 : enemy.type === "crawler" ? 0x3a2a00 : 0x6a1a1a;
    const splatOrigin = hitMeta?.hitPoint || enemy.mesh.position.clone().add(new THREE.Vector3(0, 0.6, 0));
    this.#spawnHitSplatter(splatOrigin, splatColor);
    if (enemy.type === "brute") {
      if (enemy.recentHitTimer > 0) {
        enemy.recentHitCount += 1;
      } else {
        enemy.recentHitCount = 1;
      }
      enemy.recentHitTimer = 0.5;
      const heavyStagger = enemy.recentHitCount >= 3;
      enemy.staggerTimer = heavyStagger ? 0.35 : 0.12;
      if (heavyStagger) {
        enemy.recentHitCount = 0;
      }
    }
    if (enemy.hp > 0) {
      // Pain sound on non-fatal hits (throttled — not every single bullet)
      if (Math.random() < 0.45) this.audio.playEnemyPain(enemy.type);
    }
    if (enemy.hp > 0 && hitMeta?.hitLocation) {
      const locationStagger = {
        head: 0.32,
        neck: 0.2,
        leg: 0.12,
        arm: 0.08,
      };
      enemy.staggerTimer = Math.max(enemy.staggerTimer, locationStagger[hitMeta.hitLocation] ?? 0);

      if (hitMeta.hitLocation === "leg") {
        const slowFactor = enemy.type === "brute" ? 0.78 : enemy.type === "crawler" ? 0.82 : 0.8;
        enemy.woundSlowFactor = Math.min(enemy.woundSlowFactor || 1, slowFactor);
        enemy.woundSlowTimer = Math.max(enemy.woundSlowTimer || 0, enemy.type === "brute" ? 1.8 : 1.4);
      }

      if (hitMeta.hitLocation === "arm") {
        enemy.attackCooldown = Math.max(enemy.attackCooldown, enemy.type === "brute" ? 0.45 : 0.25);
      }

      if (hitMeta.hitLocation === "head" || hitMeta.hitLocation === "neck") {
        enemy.attackCooldown = Math.max(enemy.attackCooldown, 0.18);
      }
    }
    if (enemy.hp <= 0) {
      const deathCfg = GAME_CONFIG.gameplayTuning?.deaths;
      const explodeCfg = deathCfg?.explodeThreshold;
      const dismemberCfg = deathCfg?.dismemberChance;
      const randomGibCfg = deathCfg?.randomGibChance;
      const overkillRatio = amount / Math.max(1, enemy.maxHp);
      const fatalRatio = Math.abs(enemy.hp) / Math.max(1, enemy.maxHp);
      const shotgunCloseRange = hitMeta?.weaponId === "shotgun" && (hitMeta?.distance ?? Infinity) <= 7.5;
      const explosiveKill = hitMeta?.explosive === true;
      const precisionDismemberKill = shotgunCloseRange && hitMeta?.headshot === true;
      const extremeKill = enemy.type === "brute"
        ? (overkillRatio >= (explodeCfg?.bruteOverkill ?? 1.2) || fatalRatio >= (explodeCfg?.bruteFatal ?? 0.65))
        : (overkillRatio >= (explodeCfg?.defaultOverkill ?? 0.95) || fatalRatio >= (explodeCfg?.defaultFatal ?? 0.5));
      let deathMode = "collapse";
      if (explosiveKill || extremeKill) {
        deathMode = "explode";
      } else if (precisionDismemberKill && Math.random() < (dismemberCfg?.precisionShotgunHeadshot ?? 0.88)) {
        deathMode = "dismember";
      } else if ((shotgunCloseRange || hitMeta?.headshot === true || overkillRatio >= 0.55)
        && Math.random() < (enemy.type === "brute" ? (dismemberCfg?.heavyKillBrute ?? 0.78) : (dismemberCfg?.heavyKillDefault ?? 0.72))) {
        deathMode = "dismember";
      } else if (Math.random() < (enemy.type === "brute" ? (randomGibCfg?.brute ?? 0.03) : (randomGibCfg?.default ?? 0.28))) {
        deathMode = "gib";
      }
      const gibIntensity = deathMode === "explode"
        ? (enemy.type === "brute" ? 1.85 : 1.35)
        : shotgunCloseRange
          ? (enemy.type === "brute" ? 1.45 : 1.15)
          : (enemy.type === "brute" ? 1.25 : 0.95);
      this.#killEnemy(enemy, shotDirection, deathMode, gibIntensity);
    }
  }

  #enemyPrimaryMaterial(enemy) {
    if (!enemy?.mesh) return null;
    if (enemy.mesh.isMesh && enemy.mesh.material) return enemy.mesh.material;
    let firstMaterial = null;
    enemy.mesh.traverse?.((obj) => {
      if (!firstMaterial && obj.isMesh && obj.material) {
        firstMaterial = obj.material;
      }
    });
    return firstMaterial;
  }

  #spawnEnemyGibs(enemy, shotDirection = null, intensity = 1) {
    const partSources = [];
    enemy.mesh.traverse?.((obj) => {
      if (obj.isMesh) partSources.push(obj);
    });
    if (partSources.length === 0) return;

    const maxByType = enemy.type === "brute" ? 12 : enemy.type === "crawler" ? 9 : 7;
    const spawnCount = Math.min(maxByType, Math.max(4, Math.round(partSources.length * 0.8 * intensity)));
    const nowDir = (shotDirection && shotDirection.lengthSq() > 0.0001)
      ? shotDirection.clone().normalize()
      : new THREE.Vector3(rand(-0.5, 0.5), 0, rand(-0.5, 0.5)).normalize();

    for (let i = 0; i < spawnCount; i += 1) {
      const src = partSources[Math.floor(rand(0, partSources.length))];
      const srcMat = src.material;
      const colorValue = srcMat?.color ? srcMat.color.getHex() : 0x7f878f;
      const emissiveValue = srcMat?.emissive ? srcMat.emissive.getHex() : 0x000000;
      const sourceSize = new THREE.Vector3(0.14, 0.14, 0.14);
      if (src.geometry?.boundingBox == null && src.geometry?.computeBoundingBox) {
        src.geometry.computeBoundingBox();
      }
      if (src.geometry?.boundingBox) {
        src.geometry.boundingBox.getSize(sourceSize);
      }
      const sizeScale = rand(0.35, 0.65);
      const sx = Math.max(0.06, sourceSize.x * sizeScale);
      const sy = Math.max(0.06, sourceSize.y * sizeScale);
      const sz = Math.max(0.06, sourceSize.z * sizeScale);
      const chunk = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshStandardMaterial({
          color: colorValue,
          emissive: emissiveValue,
          emissiveIntensity: srcMat?.emissiveIntensity ? srcMat.emissiveIntensity * 0.4 : 0,
          roughness: srcMat?.roughness ?? 0.85,
          metalness: srcMat?.metalness ?? 0.08,
        })
      );
      chunk.castShadow = true;
      chunk.receiveShadow = true;
      src.getWorldPosition(chunk.position);
      chunk.position.add(new THREE.Vector3(rand(-0.08, 0.08), rand(-0.08, 0.12), rand(-0.08, 0.08)));
      chunk.rotation.set(rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2));
      this.levelGroup.add(chunk);

      const kick = nowDir.clone().multiplyScalar(rand(2.2, 4.8) * intensity);
      kick.x += rand(-1.4, 1.4);
      kick.z += rand(-1.4, 1.4);
      kick.y += rand(2.2, 4.9);
      this.gibChunks.push({
        mesh: chunk,
        velocity: kick,
        spin: new THREE.Vector3(rand(-7.5, 7.5), rand(-7.5, 7.5), rand(-7.5, 7.5)),
        ttl: rand(2.2, 4.0),
      });
    }
  }

  #spawnLocalizedGore(position, shotDirection = null, intensity = 1, color = 0x640c0c) {
    const chunks = 3 + Math.floor(Math.random() * 3);
    const dir = (shotDirection && shotDirection.lengthSq() > 0.0001)
      ? shotDirection.clone().normalize()
      : new THREE.Vector3(rand(-0.5, 0.5), 0, rand(-0.5, 0.5)).normalize();

    for (let i = 0; i < chunks; i += 1) {
      const chunk = new THREE.Mesh(
        new THREE.BoxGeometry(rand(0.06, 0.12), rand(0.05, 0.11), rand(0.05, 0.1)),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.2,
          roughness: 0.9,
          metalness: 0.04,
        })
      );
      chunk.castShadow = true;
      chunk.receiveShadow = true;
      chunk.position.copy(position).add(new THREE.Vector3(rand(-0.06, 0.06), rand(-0.03, 0.07), rand(-0.06, 0.06)));
      chunk.rotation.set(rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2));
      this.levelGroup.add(chunk);

      const vel = dir.clone().multiplyScalar(rand(1.8, 3.8) * intensity);
      vel.x += rand(-1.1, 1.1);
      vel.z += rand(-1.1, 1.1);
      vel.y += rand(1.8, 4.2);
      this.gibChunks.push({
        mesh: chunk,
        velocity: vel,
        spin: new THREE.Vector3(rand(-7.2, 7.2), rand(-7.2, 7.2), rand(-7.2, 7.2)),
        ttl: rand(1.6, 3.0),
      });
    }

    this.#spawnHitSplatter(position.clone().add(new THREE.Vector3(0, 0.05, 0)), color);
  }

  #dismemberEnemy(enemy, shotDirection = null, intensity = 1) {
    const legBias = GAME_CONFIG.gameplayTuning?.deaths?.dismemberChance?.legBias ?? 0.68;
    const armCandidates = [];
    const legCandidates = [];
    enemy.mesh.traverse?.((obj) => {
      if (!obj.isMesh || obj.parent == null || obj === enemy.mesh) return;
      const p = obj.position;
      const armZone = Math.abs(p.x) > (enemy.type === "brute" ? 0.45 : 0.2) && p.y > -0.2 && p.y < 1.05;
      const legZone = Math.abs(p.x) > 0.08 && p.y < -0.35;
      if (armZone) armCandidates.push(obj);
      if (legZone) legCandidates.push(obj);
    });

    const allCandidates = armCandidates.concat(legCandidates);
    if (allCandidates.length === 0) return false;

    let pool = allCandidates;
    if (legCandidates.length > 0 && armCandidates.length > 0) {
      pool = Math.random() < legBias ? legCandidates : armCandidates;
    } else if (legCandidates.length > 0) {
      pool = legCandidates;
    }

    const lostPart = pool[Math.floor(rand(0, pool.length))];
    const hitPos = new THREE.Vector3();
    lostPart.getWorldPosition(hitPos);
    lostPart.visible = false;
    this.#spawnLocalizedGore(hitPos, shotDirection, Math.max(0.85, intensity));
    return true;
  }

  #killEnemy(enemy, shotDirection = null, deathMode = "collapse", gibIntensity = 1) {
    enemy.state = "DEAD";
    enemy.deadTime = 0;
    enemy.hitFlashTimer = 0;
    enemy.velocity.copy(shotDirection || new THREE.Vector3()).multiplyScalar(3.4);
    enemy.velocity.y += 2.2;
    this.audio.playEnemyDeath(enemy.type);
    const primaryMaterial = this.#enemyPrimaryMaterial(enemy);
    if (primaryMaterial) {
      primaryMaterial.emissiveIntensity = enemy.type === "crawler" ? 0.0 : primaryMaterial.emissiveIntensity || 0.0;
    }

    const shouldGib = deathMode === "gib" || deathMode === "explode";
    if (shouldGib) {
      this.#spawnEnemyGibs(enemy, shotDirection, gibIntensity);
      if (deathMode === "explode") {
        this.#spawnLocalizedGore(enemy.mesh.position.clone().add(new THREE.Vector3(0, 0.6, 0)), shotDirection, gibIntensity * 1.2, 0x6e0e0e);
      }
      enemy.mesh.visible = false;
      enemy.freezeRagdoll = true;
      enemy.velocity.set(0, 0, 0);
    } else if (deathMode === "dismember") {
      const dismembered = this.#dismemberEnemy(enemy, shotDirection, gibIntensity);
      if (!dismembered && Math.random() < 0.4) {
        this.#spawnEnemyGibs(enemy, shotDirection, gibIntensity * 0.75);
      }
    } else if (enemy.type === "crawler" && enemy.sprintActive) {
      enemy.velocity.addScaledVector(enemy.movementDir, 3.1);
    }

    const isToppleEnemy = enemy.type === "shamblerLab" || enemy.type === "shamblerGuard" || enemy.type === "reanimated" || enemy.type === "crawler" || enemy.type === "brute";
    if (isToppleEnemy && !shouldGib) {
      const fallDir = TMP_V2.copy(shotDirection || enemy.movementDir);
      fallDir.y = 0;
      if (fallDir.lengthSq() < 0.0001) {
        fallDir.set(rand(-1, 1), 0, rand(-1, 1));
      }
      fallDir.normalize();
      const fallAxis = TMP_V3.crossVectors(fallDir, UP);
      if (fallAxis.lengthSq() < 0.0001) {
        fallAxis.set(1, 0, 0);
      } else {
        fallAxis.normalize();
      }
      enemy.deathFallAxis.copy(fallAxis);
      enemy.deathTilt = 0;
      enemy.deathTiltTarget = enemy.type === "brute" ? rand(1.02, 1.24) : enemy.type === "crawler" ? rand(1.3, 1.62) : rand(1.22, 1.55);
      enemy.deathTiltSpeed = enemy.type === "brute" ? rand(2.5, 3.7) : enemy.type === "crawler" ? rand(5.2, 6.6) : rand(4.8, 6.2);
      enemy.deathStartQuaternion.copy(enemy.mesh.quaternion);
      enemy.deathGroundY = enemy.type === "brute" ? 0.95 : enemy.type === "crawler" ? 0.82 : enemy.type === "reanimated" ? 0.78 : 0.84;
    }

    if (this.player.grabbedBy === enemy) {
      this.#releaseGrab(enemy, false);
    }

    if (enemy.type === "brute" && Math.random() < 0.5) {
      const battery = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.2, 0.3),
        new THREE.MeshStandardMaterial({ color: 0xdda861, emissive: 0xbd6f22, emissiveIntensity: 0.5 })
      );
      battery.position.copy(enemy.mesh.position).add(new THREE.Vector3(0, 0.5, 0));
      this.levelGroup.add(battery);
      this.pickups.push(new Pickup(battery, "plasma", 30));
    }

    if (enemy.type === "shamblerLab" || enemy.type === "shamblerGuard") {
      this.corpses.push({ position: enemy.mesh.position.clone(), time: 0, used: false });
    }

    // Spawn blood pool decal on floor
    if (!shouldGib) {
      const poolColor = enemy.type === "brute" ? 0x3a0000 : enemy.type === "crawler" ? 0x2a1800 : 0x5a0808;
      const poolSize = enemy.type === "brute" ? rand(0.6, 1.1) : rand(0.3, 0.65);
      const poolMat = new THREE.MeshStandardMaterial({
        color: poolColor,
        emissive: poolColor,
        emissiveIntensity: 0.18,
        roughness: 1.0,
        metalness: 0,
        transparent: true,
        opacity: 0.82,
      });
      const pool = new THREE.Mesh(new THREE.CircleGeometry(poolSize, 8), poolMat);
      pool.rotation.x = -Math.PI * 0.5;
      pool.position.copy(enemy.mesh.position);
      pool.position.y = 0.01;
      pool.receiveShadow = false;
      this.levelGroup.add(pool);
    }

    this.stats.kills += 1;
  }

  #updateShieldRecharge(dt) {
    if (this.player.unlimitedHealth) return;
    if (this.player.shield >= this.player.maxShield) return;
    this.player.shieldRechargeTimer = Math.max(0, this.player.shieldRechargeTimer - dt);
    if (this.player.shieldRechargeTimer > 0) return;

    const prev = this.player.shield;
    this.player.shield = Math.min(
      this.player.maxShield,
      this.player.shield + GAME_CONFIG.player.shieldRechargeRate * dt
    );
    this.hud.updateShield(this.player.shield, this.player.maxShield);
    if (prev < this.player.maxShield && this.player.shield >= this.player.maxShield) {
      this.audio.playShieldRecharge();
    }
  }

  #triggerCameraShake(intensity, duration) {
    if (intensity > this.cameraShake.intensity) {
      this.cameraShake.intensity = intensity;
      this.cameraShake.timer = duration;
    }
  }

  #updateCameraShake(dt) {
    if (this.cameraShake.timer <= 0) {
      this.cameraShake.x = 0;
      this.cameraShake.y = 0;
      return;
    }
    this.cameraShake.timer = Math.max(0, this.cameraShake.timer - dt);
    const k = this.cameraShake.timer / 0.12;
    const amp = this.cameraShake.intensity * k;
    this.cameraShake.x = (Math.random() - 0.5) * amp * 2;
    this.cameraShake.y = (Math.random() - 0.5) * amp * 2;
    if (this.cameraShake.timer <= 0) this.cameraShake.intensity = 0;
  }

  #spawnHitSplatter(position, color = 0x8b1a1a) {
    const count = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i += 1) {
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 5,
        Math.random() * 2.5 + 0.5,
        (Math.random() - 0.5) * 5
      );
      const geo = new THREE.SphereGeometry(0.012 + Math.random() * 0.016, 4, 4);
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 1.2,
        metalness: 0,
        roughness: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(position);
      mesh.frustumCulled = false;
      this.levelGroup.add(mesh);
      this.sparkParticles.push({ mesh, vel, ttl: 0.18 + Math.random() * 0.14 });
    }
  }

  #spawnBulletHole(position, normal) {
    const holeGeo = new THREE.CircleGeometry(0.04 + Math.random() * 0.025, 8);
    const holeMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      emissive: 0x180800,
      emissiveIntensity: 0.4,
      roughness: 1.0,
      metalness: 0,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    const hole = new THREE.Mesh(holeGeo, holeMat);
    // Orient disc flush against the hit surface
    hole.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
    hole.position.copy(position).addScaledVector(normal.clone().normalize(), 0.012);
    hole.rotation.z = Math.random() * Math.PI * 2;
    hole.renderOrder = 1;
    this.levelGroup.add(hole);
    // Scorch ring around the hole
    const scorchGeo = new THREE.CircleGeometry(0.09 + Math.random() * 0.04, 10);
    const scorchMat = new THREE.MeshStandardMaterial({
      color: 0x1a0800,
      emissive: 0x0a0300,
      emissiveIntensity: 0.2,
      roughness: 1.0,
      metalness: 0,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const scorch = new THREE.Mesh(scorchGeo, scorchMat);
    scorch.quaternion.copy(hole.quaternion);
    scorch.position.copy(hole.position);
    scorch.renderOrder = 0;
    this.levelGroup.add(scorch);
  }

  #spawnImpactSparks(position) {
    const count = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i += 1) {
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 3 + 1,
        (Math.random() - 0.5) * 4
      );
      const geo = new THREE.SphereGeometry(0.018, 4, 4);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffe880,
        emissive: 0xffaa00,
        emissiveIntensity: 2.0,
        metalness: 0.2,
        roughness: 0.4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(position);
      mesh.frustumCulled = false;
      this.levelGroup.add(mesh);
      this.sparkParticles.push({ mesh, vel, ttl: 0.28 + Math.random() * 0.18 });
    }
    this.audio.playImpactSpark();
  }

  #updateSparks(dt) {
    for (let i = this.sparkParticles.length - 1; i >= 0; i -= 1) {
      const spark = this.sparkParticles[i];
      spark.ttl -= dt;
      spark.vel.y -= 14 * dt;
      spark.mesh.position.addScaledVector(spark.vel, dt);
      const fade = Math.max(0, spark.ttl / 0.46);
      spark.mesh.material.emissiveIntensity = fade * 2.0;
      if (spark.isRing) {
        const progress = 1 - (spark.ttl / 0.45);
        const scale = spark.ringStartScale + (spark.ringEndScale - spark.ringStartScale) * progress;
        spark.mesh.scale.setScalar(scale);
        spark.mesh.material.opacity = Math.max(0, 0.85 * (1 - progress));
      }
      if (spark.ttl <= 0) {
        this.levelGroup.remove(spark.mesh);
        spark.mesh.geometry.dispose();
        spark.mesh.material.dispose();
        this.sparkParticles.splice(i, 1);
      }
    }
  }

  #ejectShellCasing(kind = "rifle") {
    this.camera.getWorldDirection(TMP_V1);
    TMP_V2.crossVectors(TMP_V1, UP).normalize();
    TMP_V3.crossVectors(TMP_V2, TMP_V1).normalize();

    const casingSpec = kind === "shotgun"
      ? { radius: 0.013, length: 0.06, color: 0xcd2020, emissive: 0x220000 }
      : kind === "sniper"
        ? { radius: 0.009, length: 0.044, color: 0xd3ad56, emissive: 0x3a2a08 }
        : kind === "pistol"
          ? { radius: 0.008, length: 0.03, color: 0xd0a24f, emissive: 0x342508 }
          : { radius: 0.007, length: 0.027, color: 0xc89a44, emissive: 0x302307 };

    const geometry = new THREE.CylinderGeometry(casingSpec.radius, casingSpec.radius, casingSpec.length, 8);
    const material = new THREE.MeshStandardMaterial({
      color: casingSpec.color,
      emissive: casingSpec.emissive,
      emissiveIntensity: 0.18,
      metalness: 0.75,
      roughness: 0.45,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(this.camera.position)
      .addScaledVector(TMP_V1, 0.42)
      .addScaledVector(TMP_V2, 0.2)
      .addScaledVector(TMP_V3, -0.08);
    mesh.rotation.set(rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.levelGroup.add(mesh);

    const vel = TMP_V2.clone().multiplyScalar(rand(1.8, 3.2));
    vel.addScaledVector(TMP_V1, rand(0.4, 0.9));
    vel.addScaledVector(TMP_V3, rand(1.2, 2.4));
    vel.x += rand(-0.35, 0.35);
    vel.z += rand(-0.35, 0.35);

    this.shellCasings.push({
      mesh,
      vel,
      spin: new THREE.Vector3(rand(-16, 16), rand(-16, 16), rand(-16, 16)),
      ttl: rand(1.1, 1.8),
      bounces: 0,
    });

    if (this.shellCasings.length > 120) {
      const stale = this.shellCasings.shift();
      this.levelGroup.remove(stale.mesh);
      stale.mesh.geometry.dispose();
      stale.mesh.material.dispose();
    }
  }

  #updateShellCasings(dt) {
    for (let i = this.shellCasings.length - 1; i >= 0; i -= 1) {
      const casing = this.shellCasings[i];
      casing.ttl -= dt;
      casing.vel.y -= 10.8 * dt;
      casing.mesh.position.addScaledVector(casing.vel, dt);
      casing.mesh.rotation.x += casing.spin.x * dt;
      casing.mesh.rotation.y += casing.spin.y * dt;
      casing.mesh.rotation.z += casing.spin.z * dt;

      if (casing.mesh.position.y < 0.07) {
        casing.mesh.position.y = 0.07;
        if (casing.bounces < 2 && Math.abs(casing.vel.y) > 0.35) {
          casing.vel.y = Math.abs(casing.vel.y) * 0.32;
          casing.vel.x *= 0.62;
          casing.vel.z *= 0.62;
          casing.spin.multiplyScalar(0.78);
          casing.bounces += 1;
        } else {
          casing.vel.set(0, 0, 0);
          casing.spin.multiplyScalar(0.25);
        }
      }

      if (casing.ttl <= 0) {
        this.levelGroup.remove(casing.mesh);
        casing.mesh.geometry.dispose();
        casing.mesh.material.dispose();
        this.shellCasings.splice(i, 1);
      }
    }
  }

  #fireMelee() {
    if (!this.gameStarted || this.gameOver || !this.controls.isLocked) return;
    if (this.meleeCooldown > 0) return;
    this.meleeCooldown = GAME_CONFIG.player.meleeCooldown;
    this.audio.playMelee();
    this.#triggerCameraShake(0.018, 0.09);

    this.camera.getWorldDirection(TMP_V1);
    const range = GAME_CONFIG.player.meleeRange;
    let hit = false;
    for (const enemy of this.enemies) {
      if (enemy.state === "DEAD") continue;
      const toEnemy = TMP_V2.copy(enemy.mesh.position).sub(this.camera.position);
      const dist = toEnemy.length();
      if (dist > range) continue;
      toEnemy.normalize();
      const dot = TMP_V1.dot(toEnemy);
      if (dot < 0.55) continue;
      this.#damageEnemy(enemy, GAME_CONFIG.player.meleeDamage, TMP_V1.clone(), { weaponId: "melee" });
      hit = true;
    }
    if (hit) this.audio.playHitConfirm();

    // Recoil-style view punch
    this.recoil.active = true;
    this.recoil.t = 0;
  }

  #fireSniper() {
    const weapon = this.weapons.sniper;
    if (weapon.mag <= 0) { this.audio.playSniperEmpty(); return; }
    if (weapon.pumpTimer > 0) return;
    weapon.mag -= 1;
    weapon.pumpTimer = weapon.pumpTime;
    this.fireCooldown = 0.1;
    this.stats.shots += 1;
    this.audio.playSniperFire();
    this.muzzleFlashPending = true;
    this.#triggerCameraShake(0.045, 0.16);
    this.#applyRecoil(2.35, {
      lateralKick: rand(0.004, 0.012),
      rollKickDeg: rand(2.0, 4.0),
      snap: 1.25,
      recover: 0.82,
    });
    this.#ejectShellCasing("sniper");

    const hit = this.#doHitscanShot(weapon);
    if (hit) {
      this.stats.hits += 1;
      this.audio.playHitConfirm();
    }
    this.#syncHudAmmo();
  }

  #applyPlayerKnockback(fromPosition, distance, stunDuration) {
    const dir = this.camera.position.clone().sub(fromPosition);
    dir.y = 0;
    if (dir.lengthSq() < 0.0001) {
      this.camera.getWorldDirection(dir);
      dir.y = 0;
    }
    dir.normalize();
    this.player.knockbackVelocity.copy(dir).multiplyScalar(distance / 0.2);
    this.player.controlStunTimer = Math.max(this.player.controlStunTimer, stunDuration);
  }

  #releaseGrab(bruteEnemy, brokeFree) {
    if (this.player.grabbedBy !== bruteEnemy) return;
    this.player.grabbedBy = null;
    this.player.grabMashMeter = 0;
    this.player.controlStunTimer = Math.max(this.player.controlStunTimer, 0.15);
    if (brokeFree && bruteEnemy?.state !== "DEAD") {
      bruteEnemy.staggerTimer = Math.max(bruteEnemy.staggerTimer, bruteEnemy.stats.grabBreakStagger);
      bruteEnemy.attackCooldown = Math.max(bruteEnemy.attackCooldown, 1.0);
      this.#applyPlayerKnockback(bruteEnemy.mesh.position, 1.2, 0.2);
    }
  }

  #damagePlayer(amount, sourcePosition = null) {
    if (this.player.dead || this.gameOver) return;
    if (this.player.unlimitedHealth) {
      if (sourcePosition) {
        this.camera.getWorldDirection(TMP_V1);
        const toSource = TMP_V2.copy(sourcePosition).sub(this.camera.position).normalize();
        const yawForward = Math.atan2(TMP_V1.x, TMP_V1.z);
        const yawSrc = Math.atan2(toSource.x, toSource.z);
        let delta = yawSrc - yawForward;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        this.hud.showDamage(delta + Math.PI);
      }
      return;
    }
    const actual = amount * this.difficulty.playerDamageTakenMultiplier;

    // Halo-style energy shields absorb damage first
    let remaining = actual;
    if (this.player.shield > 0) {
      const absorbed = Math.min(this.player.shield, remaining);
      this.player.shield -= absorbed;
      remaining -= absorbed;
      this.hud.updateShield(this.player.shield, this.player.maxShield);
      if (this.player.shield <= 0) {
        this.hud.showShieldBreak();
        this.#triggerCameraShake(0.06, 0.22);
      } else {
        this.#triggerCameraShake(0.025, 0.12);
      }
      this.audio.playShieldHit();
    }
    this.player.shieldRechargeTimer = GAME_CONFIG.player.shieldRechargeDelay;

    this.player.hp = Math.max(0, this.player.hp - remaining);
    this.hud.updateHealth(this.player.hp);
    this.audio.setLowHealthFilter(this.player.hp < 20);
    this.combatCooldown = 5;

    if (sourcePosition) {
      this.camera.getWorldDirection(TMP_V1);
      const toSource = TMP_V2.copy(sourcePosition).sub(this.camera.position).normalize();
      const yawForward = Math.atan2(TMP_V1.x, TMP_V1.z);
      const yawSrc = Math.atan2(toSource.x, toSource.z);
      let delta = yawSrc - yawForward;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.hud.showDamage(delta + Math.PI);
    }

    if (this.player.hp <= 0) {
      this.#onLose();
    }
  }

  #onLose() {
    if (this.player.dead) return;
    this.player.dead = true;
    this.gameOver = true;
    this.controls.unlock();
    this.audio.setCombatActive(false);
    this.deathCinematicTimer = 2.0;
  }

  #showDeathMenu() {
    this.#showMessageMenu(
      "OFFICER DOWN",
      ["Mission log: Signal lost in Sector 8.", "The station remains active."],
      [
        { id: "retry", label: "Retry Level", onClick: () => this.#restartCurrentLevel() },
        { id: "menu", label: "Main Menu", onClick: () => this.#returnToMenu() },
      ]
    );
  }

  #updateDeathCinematic(dt) {
    this.deathCinematicTimer -= dt;
    const elapsed = 2.0 - this.deathCinematicTimer;
    const progress = Math.min(1, elapsed / 2.0);

    // Camera slowly rolls and drops
    this.camera.rotation.z = THREE.MathUtils.smoothstep(progress, 0, 0.65) * 0.38;
    this.camera.rotation.x += THREE.MathUtils.smoothstep(progress, 0, 0.5) * -0.0012;

    // Red vignette intensifies
    this.hud.setDeathVignette(THREE.MathUtils.smoothstep(progress, 0, 0.75));

    if (this.deathCinematicTimer <= 0) {
      this.deathCinematicTimer = 0;
      this.camera.rotation.z = 0;
      this.hud.setDeathVignette(0);
      this.#showDeathMenu();
    }
  }

  #onWin() {
    if (this.win) return;
    this.win = true;
    this.gameOver = true;
    this.controls.unlock();
    this.audio.setCombatActive(false);

    const elapsedMs = Math.max(1, performance.now() - this.stats.startedAt);
    const totalSec = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSec / 60);
    const seconds = (totalSec % 60).toString().padStart(2, "0");
    const accuracy = this.stats.shots > 0 ? Math.round((this.stats.hits / this.stats.shots) * 100) : 0;
    const shotsHit = this.stats.hits;
    const shotsFired = this.stats.shots;

    // Performance rating
    let rating, ratingColor, ratingLabel;
    if (accuracy >= 70 && totalSec <= 1200) {
      rating = "S"; ratingColor = "#ffe066"; ratingLabel = "ELITE";
    } else if (accuracy >= 55 && totalSec <= 1800) {
      rating = "A"; ratingColor = "#88ddff"; ratingLabel = "VETERAN";
    } else if (accuracy >= 38 && totalSec <= 2700) {
      rating = "B"; ratingColor = "#80ff88"; ratingLabel = "SOLDIER";
    } else {
      rating = "C"; ratingColor = "#cc99ff"; ratingLabel = "SURVIVOR";
    }

    const diffLabel = this.difficultyKey.toUpperCase();

    this.menuRoot.innerHTML = `
      <div class="menu">
        <div class="menu-card" style="width:min(560px,94vw);text-align:center;padding:32px 28px;">
          <div style="font-size:11px;letter-spacing:0.22em;color:#6aa4d8;margin-bottom:8px;text-transform:uppercase;">Mission Complete · ${diffLabel}</div>
          <h1 style="font-size:clamp(28px,5vw,48px);margin:0 0 4px;color:#aaddff;text-shadow:0 0 30px rgba(80,160,255,0.55);letter-spacing:0.12em;">RIFT SEALED</h1>
          <div style="font-size:11px;letter-spacing:0.18em;color:#4a8ab8;margin-bottom:20px;">CYGNUS X — SECTOR 8 CLEARED</div>

          <div style="display:inline-block;width:72px;height:72px;border:2px solid ${ratingColor};border-radius:4px;line-height:72px;font-size:42px;font-weight:700;color:${ratingColor};margin-bottom:6px;text-shadow:0 0 18px ${ratingColor};box-shadow:0 0 22px ${ratingColor}33;">${rating}</div>
          <div style="font-size:11px;letter-spacing:0.22em;color:${ratingColor};margin-bottom:22px;text-shadow:0 0 8px ${ratingColor}99;">${ratingLabel}</div>

          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px;text-align:left;">
            <tbody>
              <tr style="border-bottom:1px solid rgba(80,120,180,0.2);">
                <td style="padding:8px 4px;color:#7aa8d4;letter-spacing:0.1em;font-size:12px;text-transform:uppercase;">Time</td>
                <td style="padding:8px 4px;color:#ddeeff;font-weight:600;text-align:right;">${minutes}:${seconds}</td>
              </tr>
              <tr style="border-bottom:1px solid rgba(80,120,180,0.2);">
                <td style="padding:8px 4px;color:#7aa8d4;letter-spacing:0.1em;font-size:12px;text-transform:uppercase;">Accuracy</td>
                <td style="padding:8px 4px;color:#ddeeff;font-weight:600;text-align:right;">${accuracy}%</td>
              </tr>
              <tr style="border-bottom:1px solid rgba(80,120,180,0.2);">
                <td style="padding:8px 4px;color:#7aa8d4;letter-spacing:0.1em;font-size:12px;text-transform:uppercase;">Shots Fired</td>
                <td style="padding:8px 4px;color:#ddeeff;font-weight:600;text-align:right;">${shotsFired}</td>
              </tr>
              <tr style="border-bottom:1px solid rgba(80,120,180,0.2);">
                <td style="padding:8px 4px;color:#7aa8d4;letter-spacing:0.1em;font-size:12px;text-transform:uppercase;">Shots Hit</td>
                <td style="padding:8px 4px;color:#ddeeff;font-weight:600;text-align:right;">${shotsHit}</td>
              </tr>
              <tr>
                <td style="padding:8px 4px;color:#7aa8d4;letter-spacing:0.1em;font-size:12px;text-transform:uppercase;">Kills</td>
                <td style="padding:8px 4px;color:#ddeeff;font-weight:600;text-align:right;">${this.stats.kills}</td>
              </tr>
            </tbody>
          </table>

          <div class="difficulty-row" style="justify-content:center;">
            <button data-action="again">Play Again</button>
            <button data-action="menu">Main Menu</button>
          </div>
        </div>
      </div>
    `;

    this.menuRoot.querySelector('[data-action="again"]').addEventListener("click", () => this.#startGame(this.difficultyKey));
    this.menuRoot.querySelector('[data-action="menu"]').addEventListener("click", () => this.#returnToMenu());
  }

  #restartCurrentLevel() {
    this.menuRoot.innerHTML = "";
    this.gameOver = false;
    this.player.dead = false;
    this.deathCinematicTimer = 0;
    this.camera.rotation.z = 0;
    this.hud.setDeathVignette(0);
    this.player.hp = 100;
    this.player.shield = GAME_CONFIG.player.maxShield;
    this.player.shieldRechargeTimer = 0;
    this.hud.updateHealth(this.player.hp);
    this.hud.updateShield(this.player.shield, this.player.maxShield);
    this.#loadLevel(this.levelIndex);
    this.controls.lock();
  }

  #returnToMenu() {
    this.menuRoot.innerHTML = "";
    this.gameStarted = false;
    this.gameOver = false;
    this.win = false;
    this.hud.toggleJournalLog(false);
    this.#clearLevel();
    this.#showStartMenu();
  }

  #syncHudAmmo() {
    const weapon = this.weapons[this.currentWeaponId];
    if (!weapon) return;
    this.hud.updateAmmo(weapon.name, weapon.mag, weapon.reserve, weapon.mag <= 3);
  }

  #applyRecoil(scale = 1.0, profile = null) {
    this.recoil.active = true;
    this.recoil.t = 0;
    this.recoil.scale = scale;
    this.recoil.lateralKick = profile?.lateralKick ?? rand(-0.003, 0.003) * scale;
    this.recoil.rollKick = THREE.MathUtils.degToRad(profile?.rollKickDeg ?? rand(-1.4, 1.4) * scale);
    this.recoil.snap = profile?.snap ?? 1;
    this.recoil.recover = profile?.recover ?? 1;
  }

  #updateRecoil(dt) {
    if (!this.recoil.active) return;
    this.recoil.t += dt;
    const t = this.recoil.t;
    const s = this.recoil.scale ?? 1.0;
    const snap = this.recoil.snap ?? 1;
    const recover = this.recoil.recover ?? 1;
    const t1 = 0.055 / Math.max(0.7, snap);
    const t2 = t1 + 0.125 / Math.max(0.7, recover);
    const t3 = t2 + 0.05 / Math.max(0.7, recover);
    const lateralKick = this.recoil.lateralKick || 0;
    const rollKick = this.recoil.rollKick || 0;

    if (t <= t1) {
      const k = t / t1;
      this.recoil.offsetZ = THREE.MathUtils.lerp(0, 0.045 * s * snap, k);
      this.recoil.rotX = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(0, -4.8 * s * snap, k));
      this.recoil.offsetX = THREE.MathUtils.lerp(0, lateralKick, k);
      this.recoil.rotZ = THREE.MathUtils.lerp(0, rollKick, k);
    } else if (t <= t2) {
      const k = (t - t1) / (t2 - t1);
      this.recoil.offsetZ = THREE.MathUtils.lerp(0.045 * s * snap, -0.011 * s, k);
      this.recoil.rotX = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(-4.8 * s * snap, 0.7 * s, k));
      this.recoil.offsetX = THREE.MathUtils.lerp(lateralKick, -lateralKick * 0.42, k);
      this.recoil.rotZ = THREE.MathUtils.lerp(rollKick, -rollKick * 0.35, k);
    } else if (t <= t3) {
      const k = (t - t2) / (t3 - t2);
      this.recoil.offsetZ = THREE.MathUtils.lerp(-0.011 * s, 0, k);
      this.recoil.rotX = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(0.7 * s, 0, k));
      this.recoil.offsetX = THREE.MathUtils.lerp(-lateralKick * 0.42, 0, k);
      this.recoil.rotZ = THREE.MathUtils.lerp(-rollKick * 0.35, 0, k);
    } else {
      this.recoil.offsetZ = 0;
      this.recoil.rotX = 0;
      this.recoil.offsetX = 0;
      this.recoil.rotZ = 0;
      this.recoil.active = false;
    }
  }

  #updateViewModel(_dt, movementFactor) {
    const time = performance.now() * 0.001;
    const adsT = this.player.adsT;

    // Idle sway — gentle figure-8
    const swayX = Math.sin(time * 0.9) * 0.004;
    const swayY = Math.cos(time * 1.3) * 0.003;

    // Movement sway — weapon lags behind player direction changes
    const moveSway = movementFactor * 0.006;
    const bob = Math.sin(this.player.bobPhase) * this.headBobAmplitude * 0.85 * (this.player.ads ? 0.3 : 1);

    // Strafing tilt — project velocity onto camera right axis
    this.camera.getWorldDirection(TMP_V1);
    TMP_V1.y = 0;
    TMP_V1.normalize();
    TMP_V2.crossVectors(TMP_V1, UP).normalize();
    const strafeComponent = this.player.velocity.dot(TMP_V2);
    const maxSpeed = GAME_CONFIG.player.moveSpeed * GAME_CONFIG.player.sprintSpeedMultiplier;
    const strafeTilt = (strafeComponent / (maxSpeed + 0.001)) * 0.065;

    // Sprint effect — weapon drops and tilts
    const sprintDrop = this.player.sprintT * 0.035;
    const sprintTilt = this.player.sprintT * 0.08;

    this.viewModel.position.x = THREE.MathUtils.lerp(0.17 + swayX + moveSway, 0.03, adsT);
    this.viewModel.position.y = THREE.MathUtils.lerp(-0.2 + swayY + bob * 0.85 - sprintDrop, -0.145 + bob * 0.3, adsT);
    this.viewModel.position.z = -0.44 + this.recoil.offsetZ;
    this.viewModel.position.x += this.recoil.offsetX;
    this.viewModel.rotation.x = this.recoil.rotX + movementFactor * 0.015;
    this.viewModel.rotation.z = THREE.MathUtils.lerp(-sprintTilt + strafeTilt, strafeTilt * 0.3, adsT) + this.recoil.rotZ;

    // Apply camera shake offset to viewModel for extra feel
    this.viewModel.position.x += this.cameraShake.x * 0.4;
    this.viewModel.position.y += this.cameraShake.y * 0.4;

    // Weapon switch slide-down-then-up animation
    const sw = this.weaponSwitchAnim;
    if (sw.t < 1.0) {
      sw.t = Math.min(1.0, sw.t + _dt * 5.5);
      const drop = sw.t < 0.5
        ? THREE.MathUtils.smoothstep(sw.t, 0, 0.5) * 0.18
        : THREE.MathUtils.smoothstep(1.0 - sw.t, 0, 0.5) * 0.18;
      this.viewModel.position.y -= drop;
    }

    // ── Grenade cylinder rotation ─────────────────────────────────────────────
    if (this.grenadeCylGroup) {
      const diff = this.grenadeCylTargetAngle - this.grenadeCylAngle;
      if (Math.abs(diff) > 0.0005) {
        this.grenadeCylAngle += diff * Math.min(1, _dt * 18);
      }
      this.grenadeCylGroup.rotation.z = this.grenadeCylAngle;
    }

    // ── Plasma charge ring animation ─────────────────────────────────────────
    if (this.plasmaChargeRings && this.plasmaChargeRings.length > 0 && this.currentWeaponId === "plasma") {
      this.plasmaRingPulse = Math.max(0, (this.plasmaRingPulse || 0) - _dt * 3.2);
      const heatRatio = (this.weapons.plasma.overheat || 0) / (GAME_CONFIG.weapons.plasma.overheatThreshold || 24);
      const baseIntensity = 0.6 + heatRatio * 1.4;
      const pulseBoost = this.plasmaRingPulse * 4.5;
      // Color shifts from cyan (normal) to orange-red (near overheat)
      const r = Math.min(1, heatRatio * 2.2 + this.plasmaRingPulse * 1.5);
      const g = Math.max(0, 1 - heatRatio * 1.1);
      const b = Math.max(0, 1 - heatRatio * 2.0);
      for (let ri = 0; ri < this.plasmaChargeRings.length; ri += 1) {
        const ring = this.plasmaChargeRings[ri];
        const stagger = Math.sin(time * 8 + ri * 1.4) * 0.15; // sequential ripple
        const intensity = baseIntensity + pulseBoost + stagger;
        ring.material.emissive.setRGB(r, g, b);
        ring.material.emissiveIntensity = intensity;
        const scalePulse = 1 + this.plasmaRingPulse * 0.35 + heatRatio * 0.12;
        ring.scale.setScalar(scalePulse);
      }
    }

    // ── Reload animation ──────────────────────────────────────────────────────
    const ra = this.reloadAnim;
    if (ra.active) {
      ra.t = Math.min(1, ra.t + _dt / ra.totalTime);
      const p = ra.t;

      if (ra.weaponId === "shotgun") {
        // Shotgun: pump forward (z) then back
        const pump = p < 0.5
          ? THREE.MathUtils.smoothstep(p, 0, 0.5)
          : 1 - THREE.MathUtils.smoothstep(p, 0.5, 1.0);
        this.viewModel.position.z -= pump * 0.065;
        this.viewModel.position.y -= pump * 0.025;
      } else {
        // Standard mag swap: drop → tilt out → hold → snap in → return
        let dropY = 0, tiltZ = 0, tiltX = 0;

        if (p < 0.22) {
          // Phase 1: weapon drops + tilts right (clearing mag well)
          const k = THREE.MathUtils.smoothstep(p, 0, 0.22);
          dropY = k * 0.10;
          tiltZ = k * 0.28;
          tiltX = k * 0.08;
        } else if (p < 0.58) {
          // Phase 2: hold at low/tilted position (mag visually out)
          const k = THREE.MathUtils.smoothstep(p - 0.22, 0, 0.05); // quick settle
          dropY = 0.10 - k * 0.02;
          tiltZ = 0.28 - k * 0.04;
          tiltX = 0.08 - k * 0.01;
        } else if (p < 0.76) {
          // Phase 3: mag slap — upward kick + quick de-tilt
          const k = THREE.MathUtils.smoothstep(p, 0.58, 0.76);
          const snap = Math.sin(k * Math.PI);            // peaks at midpoint
          dropY = 0.08 - k * 0.10 - snap * 0.035;       // rises back with a bounce
          tiltZ = 0.24 * (1 - k);
          tiltX = 0.07 * (1 - k);
        } else {
          // Phase 4: smooth return
          const k = THREE.MathUtils.smoothstep(p, 0.76, 1.0);
          dropY = (1 - k) * 0.01;
          tiltZ = 0;
          tiltX = 0;
        }

        this.viewModel.position.y -= dropY;
        this.viewModel.rotation.z += tiltZ;
        this.viewModel.rotation.x += tiltX;
      }

      if (ra.t >= 1) ra.active = false;
    }
  }

  #updatePlayerMovement(dt) {
    if (!this.controls.isLocked || this.gameOver) return;

    this.player.controlStunTimer = Math.max(0, this.player.controlStunTimer - dt);
    const grabbedEnemy = this.player.grabbedBy;
    if (grabbedEnemy && grabbedEnemy.state !== "DEAD") {
      const holdDir = this.camera.position.clone().sub(grabbedEnemy.mesh.position);
      holdDir.y = 0;
      if (holdDir.lengthSq() < 0.0001) holdDir.set(0, 0, 1);
      holdDir.normalize();
      const holdPos = grabbedEnemy.mesh.position.clone().addScaledVector(holdDir, 0.95);
      this.camera.position.x = holdPos.x;
      this.camera.position.z = holdPos.z;
      const baseY = GAME_CONFIG.player.eyeHeight - this.player.crouchT * GAME_CONFIG.player.crouchHeightDrop;
      this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, baseY, 14, dt);
      this.hud.updateCrosshair(!this.player.ads, 0, this.currentWeaponId);
      this.#updateViewModel(dt, 0);
      this.player.lastPosition.copy(this.camera.position);
      return;
    }

    const move = new THREE.Vector3();
    const movementLocked = this.player.controlStunTimer > 0;
    if (!movementLocked) {
      if (this.input.forward) move.z += 1;
      if (this.input.backward) move.z -= 1;
      if (this.input.left) move.x -= 1;
      if (this.input.right) move.x += 1;
    }
    const moving = move.lengthSq() > 0;
    if (moving) move.normalize();

    this.player.crouchT = THREE.MathUtils.damp(this.player.crouchT, this.input.crouch ? 1 : 0, 12, dt);
    this.player.adsT = THREE.MathUtils.damp(this.player.adsT, this.player.ads ? 1 : 0, 18, dt);

    const weaponAdsFov = this.weapons[this.currentWeaponId]?.adsFov ?? GAME_CONFIG.player.adsFov;
    const canSprint = this.input.sprint && !this.input.crouch && !this.player.ads && move.lengthSq() > 0.01;
    this.player.sprintT = THREE.MathUtils.damp(this.player.sprintT, canSprint ? 1 : 0, 10, dt);
    const sprintFovBoost = this.player.sprintT * (GAME_CONFIG.player.sprintFov - GAME_CONFIG.player.fov);
    this.camera.fov = THREE.MathUtils.lerp(GAME_CONFIG.player.fov + sprintFovBoost, weaponAdsFov, this.player.adsT);
    this.camera.updateProjectionMatrix();

    this.camera.getWorldDirection(TMP_V1);
    TMP_V1.y = 0;
    TMP_V1.normalize();
    TMP_V2.crossVectors(TMP_V1, UP).normalize();
    const targetVel = TMP_V3.copy(TMP_V1).multiplyScalar(move.z).addScaledVector(TMP_V2, move.x);
    const sprintMult = canSprint ? GAME_CONFIG.player.sprintSpeedMultiplier : 1;
    const speed = GAME_CONFIG.player.moveSpeed
      * (this.input.crouch ? GAME_CONFIG.player.crouchSpeedFactor : sprintMult);
    targetVel.multiplyScalar(speed);
    this.player.velocity.lerp(targetVel, clamp01(dt * 10));

    this.player.knockbackVelocity.multiplyScalar(Math.max(0, 1 - dt * 6));
    const prev = this.camera.position.clone();
    this.camera.position.addScaledVector(this.player.velocity, dt);
    this.camera.position.addScaledVector(this.player.knockbackVelocity, dt);
    this.#resolvePlayerWallCollision();

    const motion = this.camera.position.clone().sub(prev);
    const movementFactor = clamp01(motion.length() / (speed * dt + 0.0001));
    if (movementFactor > 0.12) {
      this.player.bobPhase += dt * GAME_CONFIG.player.headBobFrequencyHz * Math.PI * 2;
      const bobOffset = Math.sin(this.player.bobPhase) * this.headBobAmplitude * (this.player.ads ? this.adsBobMultiplier : 1);
      const baseY = GAME_CONFIG.player.eyeHeight - this.player.crouchT * GAME_CONFIG.player.crouchHeightDrop;
      this.camera.position.y = baseY + bobOffset;

      const stepIndex = Math.floor(this.player.bobPhase / Math.PI);
      if (stepIndex !== this.player.bobStepIndex) {
        this.player.bobStepIndex = stepIndex;
        this.audio.playFootstep(this.input.crouch);
      }
    } else {
      const baseY = GAME_CONFIG.player.eyeHeight - this.player.crouchT * GAME_CONFIG.player.crouchHeightDrop;
      this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, baseY, 14, dt);
    }

    this.hud.updateCrosshair(!this.player.ads, movementFactor, this.currentWeaponId);
    this.#updateViewModel(dt, movementFactor);
    this.player.lastPosition.copy(this.camera.position);
  }

  #resolvePlayerWallCollision() {
    const r = GAME_CONFIG.player.capsuleRadius;
    const px = this.camera.position.x;
    const pz = this.camera.position.z;
    let x = px;
    let z = pz;

    for (const box of this.collisionBoxes) {
      if (this.camera.position.y < box.min.y - 0.1 || this.camera.position.y > box.max.y + 0.1) continue;
      const nearestX = THREE.MathUtils.clamp(x, box.min.x, box.max.x);
      const nearestZ = THREE.MathUtils.clamp(z, box.min.z, box.max.z);
      const dx = x - nearestX;
      const dz = z - nearestZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < r * r) {
        const dist = Math.sqrt(distSq) || 0.0001;
        const push = r - dist;
        x += (dx / dist) * push;
        z += (dz / dist) * push;
      }
    }

    for (const door of this.doors) {
      if (door.openAmount >= 0.98) continue;
      const dBox = new THREE.Box3().setFromObject(door.mesh);
      const nearestX = THREE.MathUtils.clamp(x, dBox.min.x, dBox.max.x);
      const nearestZ = THREE.MathUtils.clamp(z, dBox.min.z, dBox.max.z);
      const dx = x - nearestX;
      const dz = z - nearestZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < r * r) {
        const dist = Math.sqrt(distSq) || 0.0001;
        const push = r - dist;
        x += (dx / dist) * push;
        z += (dz / dist) * push;
      }
    }

    this.camera.position.x = x;
    this.camera.position.z = z;
  }

  #enemyRadius(enemy) {
    if (enemy.type === "brute") return 0.62;
    if (enemy.type === "crawler") return 0.4;
    return 0.42;
  }

  #resolveEnemyWallCollision(enemy) {
    const r = this.#enemyRadius(enemy);
    let x = enemy.mesh.position.x;
    let z = enemy.mesh.position.z;

    for (const box of this.collisionBoxes) {
      const nearestX = THREE.MathUtils.clamp(x, box.min.x, box.max.x);
      const nearestZ = THREE.MathUtils.clamp(z, box.min.z, box.max.z);
      const dx = x - nearestX;
      const dz = z - nearestZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < r * r) {
        const dist = Math.sqrt(distSq) || 0.0001;
        const push = r - dist;
        x += (dx / dist) * push;
        z += (dz / dist) * push;
      }
    }

    for (const door of this.doors) {
      if (door.openAmount >= 0.98) continue;
      const dBox = new THREE.Box3().setFromObject(door.mesh);
      const nearestX = THREE.MathUtils.clamp(x, dBox.min.x, dBox.max.x);
      const nearestZ = THREE.MathUtils.clamp(z, dBox.min.z, dBox.max.z);
      const dx = x - nearestX;
      const dz = z - nearestZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < r * r) {
        const dist = Math.sqrt(distSq) || 0.0001;
        const push = r - dist;
        x += (dx / dist) * push;
        z += (dz / dist) * push;
      }
    }

    enemy.mesh.position.x = x;
    enemy.mesh.position.z = z;
  }

  #updateDoors(dt) {
    for (const door of this.doors) {
      const dist = door.mesh.position.distanceTo(this.camera.position);
      if (!door.locked && dist <= 2) {
        door.triggered = true;
      }
      if (door.triggered) {
        door.openAmount = Math.min(1, door.openAmount + dt / 0.6);
        door.mesh.position.y = 1.5 + door.openAmount * 3;
        door.open = door.openAmount >= 0.98;
      }
    }
  }

  #updatePickups() {
    const playerPos = this.camera.position;
    for (let i = this.pickups.length - 1; i >= 0; i -= 1) {
      const pickup = this.pickups[i];
      if (!pickup.mesh.visible) continue;
      pickup.mesh.rotation.y += 0.02;
      const dist = pickup.mesh.position.distanceTo(playerPos);
      if (dist > 1.2) continue;
      pickup.mesh.visible = false;

      if (pickup.kind === "ammo") {
        this.weapons.ar.reserve = Math.min(this.weapons.ar.reserveMax, this.weapons.ar.reserve + 30);
        this.weapons.m6d.reserve = Math.min(this.weapons.m6d.reserveMax, this.weapons.m6d.reserve + pickup.amount);
        this.weapons.shotgun.reserve = Math.min(this.weapons.shotgun.reserveMax, this.weapons.shotgun.reserve + Math.ceil(pickup.amount * 0.7));
      } else if (pickup.kind === "health") {
        this.player.hp = Math.min(100, this.player.hp + pickup.amount);
        this.hud.updateHealth(this.player.hp);
        this.hud.showPickupFlash("health");
      } else if (pickup.kind === "keycard") {
        this.collectedKeys.add(pickup.keyColor);
        this.hud.updateKeycards(this.collectedKeys);
        this.hud.showKeycardToast(pickup.keyColor);
      } else if (pickup.kind === "weapon") {
        this.weapons[pickup.weaponId].unlocked = true;
        if (pickup.weaponId === "grenade") {
          this.weapons.grenade.mag = 4;
        }
        if (pickup.weaponId === "sniper") {
          this.weapons.sniper.mag = GAME_CONFIG.weapons.sniper.magSize;
          this.weapons.sniper.reserve = 8;
        }
        const weaponDisplayName = this.weapons[pickup.weaponId]?.name ?? pickup.weaponId.toUpperCase();
        this.hud.showWeaponToast(weaponDisplayName);
      } else if (pickup.kind === "plasma") {
        const wasLocked = !this.weapons.plasma.unlocked;
        this.weapons.plasma.unlocked = true;
        this.weapons.plasma.reserve += pickup.amount;
        if (wasLocked) this.hud.showWeaponToast(this.weapons.plasma.name ?? "Plasma Rifle");
      } else if (pickup.kind === "journal" && pickup.journalId) {
        const entry = JOURNAL_BY_ID[pickup.journalId];
        if (entry && !this.collectedJournalIds.has(entry.id)) {
          this.collectedJournalIds.add(entry.id);
          this.hud.showJournalPickup(entry.title, entry.text);
          this.#syncJournalHud();
        }
      }
      this.pickups.splice(i, 1);
    }
    this.#syncHudAmmo();
  }

  #updateInteractables(dt) {
    const rayDir = new THREE.Vector3();
    this.camera.getWorldDirection(rayDir);
    const playerPos = this.camera.position;
    let best = null;
    let bestScore = Infinity;

    for (const interactable of this.interactables) {
      if (interactable.mesh && !interactable.mesh.visible) continue;
      const to = interactable.mesh.position.clone().sub(playerPos);
      const dist = to.length();
      if (dist > (interactable.range || 2)) continue;
      to.normalize();
      const dot = rayDir.dot(to);
      if (dot < 0.65) continue;
      const score = dist + (1 - dot) * 4;
      if (score < bestScore) {
        bestScore = score;
        best = interactable;
      }
    }

    if (!best) {
      this.hud.hideInteract();
      this.player.interactingWith = null;
      this.player.interactionHold = 0;
      return;
    }

    if (best.prompt) this.hud.showInteract(best.prompt);

    const using = this.input.interact;
    if (using) {
      if (best.holdDuration && best.onHold) {
        best.onHold(dt);
      } else if (best.onInteract) {
        best.onInteract();
      }
    } else if (best.holdDuration) {
      if (best.mesh?.userData?.anchorRef) {
        best.mesh.userData.anchorRef.holdProgress = 0;
      }
    }
    this.player.interactingWith = best;
  }

  #updateEnemyAI(dt) {
    const playerPos = this.camera.position;
    let anyAlerted = false;

    if (this.player.grabbedBy) {
      this.player.grabMashMeter = Math.max(0, this.player.grabMashMeter - dt * 2.5);
    } else {
      this.player.grabMashMeter = 0;
    }

    for (const enemy of this.enemies) {
      if (enemy.state === "DEAD") {
        this.#updateDeadEnemy(enemy, dt);
        continue;
      }

      const toPlayer = TMP_V1.copy(playerPos).sub(enemy.mesh.position);
      const dist = toPlayer.length();
      if (dist > 30 && enemy.state !== "ALERT" && enemy.state !== "ATTACK") {
        continue;
      }
      if (enemy.state === "ALERT" || enemy.state === "ATTACK") anyAlerted = true;
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
      enemy.staggerTimer = Math.max(0, enemy.staggerTimer - dt);
      enemy.recentHitTimer = Math.max(0, enemy.recentHitTimer - dt);
      enemy.woundSlowTimer = Math.max(0, (enemy.woundSlowTimer || 0) - dt);
      if (enemy.woundSlowTimer <= 0) {
        enemy.woundSlowFactor = 1;
      }
      if (enemy.recentHitTimer <= 0) {
        enemy.recentHitCount = 0;
      }

      if (enemy.type === "shamblerLab" || enemy.type === "shamblerGuard" || enemy.type === "reanimated") {
        this.#updateShambler(enemy, dt, dist, toPlayer, playerPos);
      } else if (enemy.type === "crawler") {
        this.#updateCrawler(enemy, dt, dist, toPlayer, playerPos);
      } else if (enemy.type === "brute") {
        this.#updateBrute(enemy, dt, dist, toPlayer, playerPos);
      }
      this.#animateEnemy(enemy, dt);
    }

    this.combatCooldown = Math.max(0, this.combatCooldown - dt);
    this.audio.setCombatActive(anyAlerted || this.combatCooldown > 0);
  }

  #updateShambler(enemy, dt, dist, toPlayer, playerPos) {
    if (enemy.isIntroSentinel && enemy.state === "IDLE") {
      const playerRoom = this.#getNearestRoomIndex(playerPos);
      if (playerRoom >= 1 || dist < 7.5) {
        this.audio.playAlertBark(enemy.type);
        enemy.alertBarked = true;
        enemy.state = "ALERT";
        enemy.lastKnownPlayerPos.copy(playerPos);
        enemy.alertTimer = 8;
      } else {
        this.#faceTargetFlat(enemy, playerPos, 0);
        return;
      }
    }

    const moanRadius = this.difficulty.shamblerMoanRadius;
    const closeSight = dist < 10 + (this.player.sprintT > 0.5 ? 6 : 0);
    enemy.alertTimer = Math.max(0, enemy.alertTimer - dt);

    if (closeSight) {
      if (enemy.state !== "ALERT" && enemy.state !== "ATTACK" && !enemy.alertBarked) {
        this.audio.playAlertBark(enemy.type);
        enemy.alertBarked = true;
      }
      enemy.state = "ALERT";
      enemy.lastKnownPlayerPos.copy(playerPos);
      enemy.alertTimer = 8;
      if (!enemy.moanEmitted) {
        this.audio.playShamblerMoan();
        this.#alertNearbyShamblers(enemy.mesh.position, moanRadius);
        enemy.moanEmitted = true;
      }
    }

    if (enemy.alertTimer <= 0 && enemy.state !== "ATTACK") {
      enemy.state = "PATROL";
      enemy.moanEmitted = false;
      enemy.alertBarked = false;
    }

    const target = enemy.state === "PATROL" ? this.rooms[enemy.roomIndex].center : enemy.lastKnownPlayerPos;
    const desired = TMP_V2.copy(target).sub(enemy.mesh.position);
    desired.y = 0;
    const desiredLen = desired.length();
    if (desiredLen > 0.2) desired.normalize();

    const speed = (dist < 6 ? enemy.stats.speedLurch : enemy.stats.speedSlow) * (enemy.woundSlowFactor || 1);
    if (enemy.staggerTimer <= 0) {
      const hobbleAngle = Math.sin(performance.now() * 0.006 + enemy.roomIndex * 1.27) * 0.28;
      TMP_V3.copy(desired);
      if (desiredLen > 0.2) {
        TMP_V3.applyAxisAngle(UP, hobbleAngle);
      }
      enemy.mesh.position.addScaledVector(TMP_V3, speed * dt);
      this.#resolveEnemyWallCollision(enemy);
    }
    this.#faceTargetFlat(enemy, playerPos, Math.sin(performance.now() * 0.01 + enemy.roomIndex) * 0.1);

    if (dist < 1.15) {
      enemy.state = "ATTACK";
      if (enemy.attackCooldown <= 0) {
        enemy.attackCooldown = enemy.stats.attackCooldown;
        this.#damagePlayer(enemy.stats.bodyDamage, enemy.mesh.position);
      }
    }
  }

  #updateCrawler(enemy, dt, dist, toPlayer, playerPos) {
    if (enemy.reanimateTimer > 0) {
      enemy.reanimateTimer -= dt;
      if (enemy.reanimateTimer <= 0 && enemy.reanimateTarget && enemy.reanimateTarget.used === false) {
        enemy.reanimateTarget.used = true;
        const mesh = this.#spawnEnemyMesh("shamblerLab");
        mesh.position.copy(enemy.reanimateTarget.position).setY(0.9);
        this.levelGroup.add(mesh);
        const stats = GAME_CONFIG.enemyStats.reanimated;
        const revived = new Enemy("reanimated", mesh, { ...stats, hp: Math.round(stats.hp * this.difficulty.enemyHpMultiplier) }, enemy.roomIndex);
        revived.state = "ALERT";
        revived.lastKnownPlayerPos.copy(this.camera.position);
        this.enemies.push(revived);
      }
      return;
    }

    if (!enemy.reanimateTarget) {
      for (const corpse of this.corpses) {
        if (corpse.used || corpse.time > GAME_CONFIG.enemyStats.crawler.freshCorpseWindow) continue;
        if (corpse.position.distanceTo(enemy.mesh.position) < 1.8) {
          enemy.reanimateTarget = corpse;
          enemy.reanimateTimer = GAME_CONFIG.enemyStats.crawler.reanimateDuration;
          return;
        }
      }
    }

    this.#faceTargetFlat(enemy, playerPos, 0);

    if (enemy.comboStep === 1) {
      enemy.comboTimer -= dt;
      if (enemy.comboTimer <= 0) {
        if (enemy.mesh.position.distanceTo(playerPos) <= enemy.stats.swipeRange) {
          this.#damagePlayer(enemy.stats.swipeDamage, enemy.mesh.position);
        }
        enemy.comboStep = 0;
      }
      return;
    }

    if (dist <= enemy.stats.swipeRange && enemy.attackCooldown <= 0) {
      if (enemy.mesh.position.distanceTo(playerPos) <= enemy.stats.swipeRange) {
        this.#damagePlayer(enemy.stats.swipeDamage, enemy.mesh.position);
      }
      enemy.comboStep = 1;
      enemy.comboTimer = enemy.stats.swipeDelay;
      enemy.attackCooldown = enemy.stats.comboCooldown;
      enemy.sprintActive = false;
      return;
    }

    toPlayer.y = 0;
    if (toPlayer.lengthSq() > 0.001) toPlayer.normalize();
    const crawlSpeedScale = (this.difficulty.crawlerSpeed || 5.5) / 5.5;
    const speed = (dist <= enemy.stats.sprintRange ? enemy.stats.sprintSpeed : enemy.stats.walkSpeed)
      * crawlSpeedScale
      * (enemy.woundSlowFactor || 1);
    enemy.sprintActive = dist <= enemy.stats.sprintRange;
    enemy.mesh.position.addScaledVector(toPlayer, speed * dt);
    enemy.movementDir.copy(toPlayer);
    this.#resolveEnemyWallCollision(enemy);
  }

  #updateBrute(enemy, dt, dist, toPlayer, playerPos) {
    const hpRatio = enemy.hp / enemy.maxHp;

    if (enemy.attackMode === "grab") {
      if (this.player.grabbedBy !== enemy) {
        enemy.attackMode = "none";
        enemy.grabTimer = 0;
        return;
      }
      enemy.grabTimer -= dt;
      enemy.grabTickTimer -= dt;
      this.#faceTargetFlat(enemy, playerPos, 0);

      if (this.player.grabMashMeter >= 8) {
        this.#releaseGrab(enemy, true);
        enemy.attackMode = "none";
        return;
      }

      if (enemy.grabTickTimer <= 0) {
        this.#damagePlayer(enemy.stats.grabTickDamage, enemy.mesh.position);
        enemy.grabTickTimer += enemy.stats.grabTickInterval;
      }

      if (enemy.grabTimer <= 0) {
        this.#releaseGrab(enemy, false);
        enemy.attackMode = "none";
      }
      return;
    }

    if (enemy.attackMode === "haymakerWindup") {
      enemy.attackTimer -= dt;
      this.#faceTargetFlat(enemy, playerPos, 0);
      if (enemy.attackTimer <= 0) {
        const inRange = enemy.mesh.position.distanceTo(playerPos) <= enemy.stats.haymakerRange;
        if (inRange) {
          this.#damagePlayer(enemy.stats.haymakerDamage, enemy.mesh.position);
        }
        enemy.attackMode = "recover";
        enemy.attackTimer = inRange ? 0.25 : enemy.stats.haymakerMissRecovery;
      }
      return;
    }

    if (enemy.attackMode === "recover") {
      enemy.attackTimer -= dt;
      if (enemy.attackTimer <= 0) {
        enemy.attackMode = "none";
      }
      return;
    }

    if (enemy.guardRoomIndex != null && dist > 9 && enemy.attackMode === "none") {
      const guardRoom = this.rooms[enemy.guardRoomIndex];
      const toGuard = TMP_V2.copy(guardRoom.center).sub(enemy.mesh.position);
      toGuard.y = 0;
      if (toGuard.lengthSq() > 0.06) {
        toGuard.normalize();
        enemy.mesh.position.addScaledVector(toGuard, enemy.stats.speed * (enemy.woundSlowFactor || 1) * 0.7 * dt);
        enemy.movementDir.copy(toGuard);
        this.#resolveEnemyWallCollision(enemy);
      }
      this.#faceTargetFlat(enemy, guardRoom.center, 0);
      return;
    }

    if (dist < 12 && !enemy.alertBarked) {
      this.audio.playAlertBark("brute");
      enemy.alertBarked = true;
    }

    if (enemy.staggerTimer <= 0) {
      toPlayer.y = 0;
      if (toPlayer.lengthSq() > 0.001) toPlayer.normalize();
      enemy.mesh.position.addScaledVector(toPlayer, enemy.stats.speed * (enemy.woundSlowFactor || 1) * dt);
      enemy.movementDir.copy(toPlayer);
      this.#resolveEnemyWallCollision(enemy);
    }

    this.#faceTargetFlat(enemy, playerPos, 0);
    const facing = enemy.movementDir.lengthSq() > 0.001 ? enemy.movementDir.clone() : toPlayer.clone().normalize();
    const toPlayerFlat = playerPos.clone().sub(enemy.mesh.position).setY(0).normalize();
    const frontDot = clamp01(facing.dot(toPlayerFlat));

    if (enemy.attackCooldown > 0 || enemy.staggerTimer > 0) {
      return;
    }

    if (hpRatio <= enemy.stats.grabThresholdHpRatio && dist <= enemy.stats.grabRange && Math.random() < 0.2 && !this.player.grabbedBy) {
      enemy.attackMode = "grab";
      enemy.grabTimer = enemy.stats.grabDuration;
      enemy.grabTickTimer = enemy.stats.grabTickInterval;
      enemy.attackCooldown = 1.8;
      this.player.grabbedBy = enemy;
      this.player.grabMashMeter = 0;
      this.player.controlStunTimer = Math.max(this.player.controlStunTimer, enemy.stats.grabDuration);
      return;
    }

    if (dist <= enemy.stats.shoveRange && frontDot > 0.72) {
      this.#damagePlayer(enemy.stats.shoveDamage, enemy.mesh.position);
      this.#applyPlayerKnockback(enemy.mesh.position, enemy.stats.shoveKnockback, enemy.stats.shoveStun);
      enemy.attackCooldown = 1.2;
      return;
    }

    if (dist <= enemy.stats.haymakerRange + 0.7) {
      enemy.attackMode = "haymakerWindup";
      enemy.attackTimer = enemy.stats.haymakerWindup;
      enemy.attackCooldown = enemy.stats.haymakerWindup + enemy.stats.haymakerMissRecovery;
    }
  }

  /** Animate enemy limbs (arms/legs swinging) based on movement state. */
  #animateEnemy(enemy, dt) {
    if (enemy.state === "DEAD" || enemy.freezeRagdoll) return;

    const moving = enemy.state === "PATROL" || enemy.state === "ALERT" || enemy.state === "ATTACK";
    const speed = enemy.sprintActive ? 2.8 : 1.4;
    enemy.animTime += dt * (moving ? speed : 0.3);

    // Collect typed limb references by position heuristic
    const arms = [];
    const legs = [];
    enemy.mesh.traverse((obj) => {
      if (!obj.isMesh || obj === enemy.mesh) return;
      const p = obj.position;
      const isArm = Math.abs(p.x) > (enemy.type === "brute" ? 0.45 : 0.18) && p.y > -0.2 && p.y < 1.1;
      const isLeg = Math.abs(p.x) > 0.06 && p.y < -0.28;
      if (isArm) arms.push(obj);
      if (isLeg) legs.push(obj);
    });

    const t = enemy.animTime;
    const ampArm = moving ? (enemy.sprintActive ? 0.38 : 0.22) : 0.06;
    const ampLeg = moving ? (enemy.sprintActive ? 0.45 : 0.28) : 0.04;
    const brute = enemy.type === "brute";

    // Alternate arm swing (left forward when right leg forward)
    for (let i = 0; i < arms.length; i += 1) {
      const side = arms[i].position.x < 0 ? 1 : -1;
      const phase = side * (brute ? 0.8 : 1.0);
      arms[i].rotation.x = Math.sin(t + phase) * ampArm * (brute ? 0.5 : 1);
      // Brute: also shoulder roll
      if (brute) arms[i].rotation.z = (arms[i].position.x < 0 ? 0.08 : -0.08) + Math.sin(t * 0.5) * 0.04;
    }
    for (let i = 0; i < legs.length; i += 1) {
      const side = legs[i].position.x < 0 ? -1 : 1;
      legs[i].rotation.x = Math.sin(t + side * 0.5) * ampLeg;
    }

    // Idle/attack head bob for crawlers
    if (enemy.type === "crawler") {
      enemy.mesh.traverse((obj) => {
        if (!obj.isMesh || obj === enemy.mesh) return;
        if (obj.position.y > 0.7) {
          obj.rotation.x = Math.sin(t * 1.2) * (moving ? 0.12 : 0.06);
        }
      });
    }

    // Hit flash: briefly tint all materials bright red/white then fade
    if (enemy.hitFlashTimer > 0) {
      enemy.hitFlashTimer = Math.max(0, enemy.hitFlashTimer - dt);
      const intensity = Math.min(1, enemy.hitFlashTimer / 0.08) * 3.0;
      enemy.mesh.traverse((obj) => {
        if (obj.isMesh && obj.material) {
          obj.material.emissiveIntensity = intensity;
          if (!obj.material._flashColorSet) {
            obj.material._origEmissive = obj.material.emissive.clone();
            obj.material._flashColorSet = true;
          }
          obj.material.emissive.setHex(0xff2200);
        }
      });
    } else {
      // Restore original emissive when flash ends
      enemy.mesh.traverse((obj) => {
        if (obj.isMesh && obj.material && obj.material._flashColorSet) {
          obj.material.emissive.copy(obj.material._origEmissive);
          obj.material._flashColorSet = false;
          // Let normal emissiveIntensity be managed elsewhere
        }
      });
    }
  }

  #updateDeadEnemy(enemy, dt) {
    if (enemy.freezeRagdoll) return;
    enemy.deadTime += dt;
    enemy.velocity.y -= 9.8 * dt;
    enemy.mesh.position.addScaledVector(enemy.velocity, dt);

    const isToppleEnemy = enemy.type === "shamblerLab" || enemy.type === "shamblerGuard" || enemy.type === "reanimated" || enemy.type === "crawler" || enemy.type === "brute";
    if (isToppleEnemy) {
      enemy.deathTilt = Math.min(enemy.deathTiltTarget, enemy.deathTilt + enemy.deathTiltSpeed * dt);
      const tiltQuat = new THREE.Quaternion().setFromAxisAngle(enemy.deathFallAxis, enemy.deathTilt);
      enemy.mesh.quaternion.copy(enemy.deathStartQuaternion).multiply(tiltQuat);

      if (enemy.mesh.position.y < enemy.deathGroundY) {
        enemy.mesh.position.y = enemy.deathGroundY;
        enemy.velocity.y = 0;
      }
      enemy.velocity.x *= 0.9;
      enemy.velocity.z *= 0.9;
    } else if (enemy.mesh.position.y < 0.9) {
      enemy.mesh.position.y = 0.9;
      enemy.velocity.multiplyScalar(0.42);
    }

    if (enemy.type === "brute") {
      const mat = this.#enemyPrimaryMaterial(enemy);
      if (mat) {
        mat.emissiveIntensity = Math.max(0, 0.4 - enemy.deadTime * 0.2);
      }
    }
    if (isToppleEnemy && enemy.deathTilt >= enemy.deathTiltTarget && enemy.deadTime > 0.8) {
      enemy.freezeRagdoll = true;
      return;
    }
    if (enemy.deadTime > 3) {
      enemy.freezeRagdoll = true;
    }
  }

  #alertNearbyShamblers(origin, radius) {
    for (const enemy of this.enemies) {
      if (enemy.state === "DEAD") continue;
      if (!(enemy.type === "shamblerLab" || enemy.type === "shamblerGuard" || enemy.type === "reanimated")) continue;
      if (enemy.mesh.position.distanceTo(origin) > radius) continue;
      enemy.state = "ALERT";
      enemy.lastKnownPlayerPos.copy(this.camera.position);
      enemy.alertTimer = 8;
    }
  }

  #updateProjectiles(dt) {
    for (let i = this.playerProjectiles.length - 1; i >= 0; i -= 1) {
      const p = this.playerProjectiles[i];
      p.ttl -= dt;
      p.vel.y -= 9.8 * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.mesh) {
        p.mesh.position.copy(p.pos);
        p.mesh.rotation.x += dt * 9;
        p.mesh.rotation.z += dt * 7;
      }

      let hitEnemy = false;
      if (p.kind === "grenade") {
        for (const enemy of this.enemies) {
          if (enemy.state === "DEAD") continue;
          const hitRadius = enemy.type === "brute" ? 1.05 : enemy.type === "crawler" ? 0.75 : 0.85;
          if (enemy.mesh.position.distanceTo(p.pos) <= hitRadius) {
            hitEnemy = true;
            break;
          }
        }
      }

      if (hitEnemy || p.pos.y < 0.12 || p.ttl <= 0) {
        if (p.kind === "grenade") this.#explodeGrenade(p.pos);
        if (p.mesh) this.levelGroup.remove(p.mesh);
        this.playerProjectiles.splice(i, 1);
        continue;
      }
    }
  }

  #explodeGrenade(position) {
    const weapon = this.weapons.grenade;
    this.audio.playExplosion();

    const radius = Math.max(0.1, weapon.radius || 0);
    for (const enemy of this.enemies) {
      if (enemy.state === "DEAD") continue;
      TMP_V1.copy(enemy.mesh.position).sub(position);
      const planarDist = planarDistanceXZ(enemy.mesh.position, position);
      if (planarDist > radius) continue;
      const damage = weapon.damage * splashFalloff(planarDist, radius, 0.2);
      TMP_V1.y = Math.max(TMP_V1.y, 0.2);
      TMP_V1.normalize();
      this.#damageEnemy(enemy, damage, TMP_V1.clone(), {
        weaponId: "grenade",
        explosive: true,
        distance: planarDist,
      });
    }

    TMP_V1.copy(this.camera.position).sub(position);
    const playerPlanarDist = planarDistanceXZ(this.camera.position, position);
    if (playerPlanarDist <= radius) {
      const playerDamage = weapon.damage * 0.35 * splashFalloff(playerPlanarDist, radius, 0.15);
      this.#damagePlayer(playerDamage, position);
      const shock = THREE.MathUtils.lerp(0.01, 0.035, 1 - playerPlanarDist / radius);
      this.#triggerCameraShake(shock, 0.16);
    }

    // Shockwave ring
    const ringGeo = new THREE.TorusGeometry(0.1, 0.06, 6, 24);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xff5500, emissive: 0xff3300, emissiveIntensity: 2.5,
      metalness: 0.1, roughness: 0.5, transparent: true, opacity: 0.85,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(position);
    ring.rotation.x = Math.PI / 2;
    this.levelGroup.add(ring);
    this.sparkParticles.push({
      mesh: ring,
      vel: new THREE.Vector3(0, 0.1, 0),
      ttl: 0.45,
      isRing: true,
      ringStartScale: 0.1,
      ringEndScale: 6.0,
    });
  }

  #updateGibs(dt) {
    for (let i = this.gibChunks.length - 1; i >= 0; i -= 1) {
      const chunk = this.gibChunks[i];
      chunk.ttl -= dt;
      chunk.velocity.y -= 9.8 * dt;
      chunk.mesh.position.addScaledVector(chunk.velocity, dt);
      chunk.mesh.rotation.x += chunk.spin.x * dt;
      chunk.mesh.rotation.y += chunk.spin.y * dt;
      chunk.mesh.rotation.z += chunk.spin.z * dt;
      if (chunk.mesh.position.y < 0.08) {
        chunk.mesh.position.y = 0.08;
        chunk.velocity.y = Math.abs(chunk.velocity.y) * 0.24;
        chunk.velocity.x *= 0.75;
        chunk.velocity.z *= 0.75;
      }
      if (chunk.ttl <= 0) {
        this.levelGroup.remove(chunk.mesh);
        this.gibChunks.splice(i, 1);
      }
    }
  }

  #updateMuzzleFlash() {
    for (const light of this.oneFrameLights) {
      this.scene.remove(light);
    }
    this.oneFrameLights.length = 0;

    if (!this.muzzleFlashPending) return;
    this.muzzleFlashPending = false;

    this.camera.getWorldDirection(TMP_V1);
    const flashColor = WEAPON_FLASH_COLORS[this.currentWeaponId] || 0xffe8a0;
    const flashIntensity = this.currentWeaponId === "sniper"
      ? 22
      : this.currentWeaponId === "shotgun"
        ? 18
        : this.currentWeaponId === "plasma"
          ? 20
          : 11;
    const flashRange = this.currentWeaponId === "shotgun"
      ? 7
      : this.currentWeaponId === "sniper"
        ? 8
        : this.currentWeaponId === "plasma"
          ? 7
          : 5;
    const light = new THREE.PointLight(flashColor, flashIntensity, flashRange, 2);
    light.position.copy(this.camera.position).add(TMP_V1.clone().multiplyScalar(0.9));
    this.scene.add(light);
    this.oneFrameLights.push(light);

    // Spawn muzzle sparks for heavier weapons
    const sparkCount = this.currentWeaponId === "shotgun" ? 8
      : this.currentWeaponId === "sniper" ? 6
      : this.currentWeaponId === "plasma" ? 6
      : this.currentWeaponId === "m6d" ? 4
      : 2;
    const muzzlePos = this.camera.position.clone().add(TMP_V1.clone().multiplyScalar(1.1));
    const flashColorObj = new THREE.Color(flashColor);
    for (let i = 0; i < sparkCount; i += 1) {
      const vel = TMP_V1.clone().multiplyScalar(rand(2, 5));
      vel.x += rand(-2.5, 2.5);
      vel.y += rand(-1, 2);
      vel.z += rand(-2.5, 2.5);
      const geo = new THREE.SphereGeometry(0.01 + Math.random() * 0.01, 3, 3);
      const mat = new THREE.MeshStandardMaterial({
        color: flashColorObj,
        emissive: flashColorObj,
        emissiveIntensity: 3.0,
        metalness: 0,
        roughness: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(muzzlePos);
      mesh.frustumCulled = false;
      this.levelGroup.add(mesh);
      this.sparkParticles.push({ mesh, vel, ttl: 0.06 + Math.random() * 0.08 });
    }
  }

  #updateCrates(dt) {
    if (!this.crateMesh) return;
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < this.crates.length; i += 1) {
      const crate = this.crates[i];
      crate.vel.multiplyScalar(0.94);
      crate.pos.addScaledVector(crate.vel, dt);
      matrix.makeTranslation(crate.pos.x, crate.pos.y, crate.pos.z);
      this.crateMesh.setMatrixAt(i, matrix);
    }
    this.crateMesh.instanceMatrix.needsUpdate = true;
  }

  #updateFlickerAndAlarms(dt) {
    const now = performance.now() * 0.001;
    for (const info of this.flickerLights) {
      if (info.downTime > 0) {
        info.downTime -= dt;
        if (info.downTime <= 0) info.light.intensity = 1.2;
        continue;
      }
      info.timer -= dt;
      if (info.timer <= 0) {
        info.timer = rand(0.5, 3);
        info.downTime = rand(0.05, 0.15);
        info.light.intensity = 0;
      }
    }

    const period = 4;
    for (const info of this.rotatingAlarmLights) {
      const a = ((now + info.phase) / period) * Math.PI * 2;
      info.light.position.x = info.baseX + Math.cos(a) * 0.7;
      info.light.position.z = info.baseZ + Math.sin(a) * 0.7;
    }
  }

  #updateTracker(dt) {
    this.trackerTimer += dt;
    if (this.trackerTimer < 1) return;
    this.trackerTimer = 0;

    const range = this.difficulty.motionTrackerRange;
    const blips = [];
    const playerPos = this.camera.position;
    this.camera.getWorldDirection(TMP_V1);
    const playerYaw = Math.atan2(TMP_V1.x, TMP_V1.z);

    for (const enemy of this.enemies) {
      if (enemy.state === "DEAD") continue;
      const speed = enemy.velocity.length() + (enemy.state === "PATROL" ? 0.1 : 0.6);
      if (speed < 0.15) continue;
      const offset = enemy.mesh.position.clone().sub(playerPos);
      offset.y = 0;
      const dist = offset.length();
      if (dist > range) continue;
      const yaw = Math.atan2(offset.x, offset.z) - playerYaw;
      const norm = clamp01(dist / range);
      const color = enemy.type === "brute"
        ? "#ff4444"
        : enemy.type === "crawler"
          ? "#ffaa22"
          : "#78ff96";
      blips.push({ x: Math.sin(yaw) * norm, y: -Math.cos(yaw) * norm, color, size: enemy.type === "brute" ? 5 : 3 });
    }

    for (const ghost of this.trackerGhostBlips) {
      blips.push({ x: ghost.x, y: ghost.y, color: "rgba(140,180,220,0.6)", size: 2.5 });
    }

    if (blips.length > this.lastTrackerBlipCount) {
      this.audio.playHitConfirm();
    }
    this.lastTrackerBlipCount = blips.length;
    this.hud.drawTracker(blips, this.player.ads);
  }

  #updateDoorsExitLogic() {
    if (this.levelIndex === LEVELS.length - 1) return;
    const lastRoomIndex = this.rooms.length - 1;
    const lastRoom = this.rooms[lastRoomIndex];
    // Only require the final two rooms to be cleared — stragglers in early rooms don't block exit
    const clearZoneStart = Math.max(0, lastRoomIndex - 1);
    const clearRooms = this.rooms.slice(clearZoneStart, lastRoomIndex + 1);
    const aliveInFinalZone = this.enemies.some(
      (e) => e.state !== "DEAD" && clearRooms.some((room) => this.#positionInsideRoomFootprint(e.mesh.position, room, 0.35))
    );
    const inExitZone = this.#playerInsideRoomFootprint(lastRoom, 0.5);
    if (inExitZone && !aliveInFinalZone) {
      this.hud.showInteract("Press E — exit to next level (anywhere in this room)");
      if (this.input.interact && !this.levelTransitioning) {
        this.levelTransitioning = true;
        this.input.interact = false;
        this.controls.unlock();
        const nextIndex = this.levelIndex + 1;
        const nextLevel = LEVELS[nextIndex];
        this.audio.playLevelTransition();
        this.hud.showLevelTransition(nextLevel.name, nextLevel.subtitle ?? "", () => {
          this.levelIndex = nextIndex;
          this.#loadLevel(this.levelIndex);
          this.levelTransitioning = false;
          this.controls.lock();
        });
      }
    }
  }

  #updateLevelAmbientEvents(dt) {
    this.levelTime += dt;
    this.#processScriptedEvents(dt);
    this.#updateAmbientAudio(dt);

    for (const corpse of this.corpses) {
      corpse.time += dt;
    }
    // Prune corpses that are past the reanimation window — crawlers can no longer use them
    const freshWindow = GAME_CONFIG.enemyStats.crawler.freshCorpseWindow;
    if (this.corpses.length > 0 && this.corpses[0].time > freshWindow) {
      this.corpses = this.corpses.filter((c) => c.time <= freshWindow);
    }

    for (let i = this.trackerGhostBlips.length - 1; i >= 0; i -= 1) {
      const ghost = this.trackerGhostBlips[i];
      ghost.ttl -= dt;
      if (ghost.ttl <= 0) {
        this.trackerGhostBlips.splice(i, 1);
      }
    }

    for (const screen of this.broadcastScreens) {
      screen.timer -= dt;
      screen.glitchTimer = Math.max(0, screen.glitchTimer - dt);
      if (screen.timer <= 0) {
        screen.timer = rand(2.5, 7.5);
        screen.glitchTimer = rand(0.12, 0.36);
        this.audio.playBroadcastGlitch();
      }
      const pulse = 0.25 + Math.sin(performance.now() * 0.003 + screen.mesh.position.x) * 0.07;
      const glitchBoost = screen.glitchTimer > 0 ? rand(0.1, 0.4) : 0;
      screen.mesh.material.emissiveIntensity = screen.baseIntensity + pulse + glitchBoost;
    }
  }

  #manualSave() {
    if (!this.gameStarted || this.gameOver) return;
    if (!this.difficulty.allowManualSave) return;
    const payload = {
      levelIndex: this.levelIndex,
      difficultyKey: this.difficultyKey,
      hp: this.player.hp,
      currentWeaponId: this.currentWeaponId,
      weapons: {
        ar: { mag: this.weapons.ar.mag, reserve: this.weapons.ar.reserve, unlocked: this.weapons.ar.unlocked },
        m6d: { mag: this.weapons.m6d.mag, reserve: this.weapons.m6d.reserve, unlocked: this.weapons.m6d.unlocked },
        shotgun: { mag: this.weapons.shotgun.mag, reserve: this.weapons.shotgun.reserve, unlocked: this.weapons.shotgun.unlocked },
        plasma: { mag: this.weapons.plasma.mag, reserve: this.weapons.plasma.reserve, unlocked: this.weapons.plasma.unlocked },
        grenade: { mag: this.weapons.grenade.mag, reserve: this.weapons.grenade.reserve, unlocked: this.weapons.grenade.unlocked },
        sniper: { mag: this.weapons.sniper.mag, reserve: this.weapons.sniper.reserve, unlocked: this.weapons.sniper.unlocked },
      },
      keys: [...this.collectedKeys],
      journalIds: [...this.collectedJournalIds],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  #autoSaveOnLevelLoad() {
    if (!this.gameStarted || !this.difficulty.allowManualSave) return;
    this.#manualSave();
  }

  #tryLoadManualSave() {
    if (!this.difficulty.allowManualSave) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
      const data = JSON.parse(raw);
      if (!data || data.difficultyKey !== this.difficultyKey) return;
      this.collectedKeys = new Set(data.keys || []);
      this.collectedJournalIds = new Set(
        Array.isArray(data.journalIds) ? data.journalIds.filter((id) => JOURNAL_BY_ID[id]) : []
      );
      this.levelIndex = Math.max(0, Math.min(LEVELS.length - 1, data.levelIndex || 0));
      if (this.levelIndex !== LEVELS.findIndex((lvl) => lvl.id === this.level.id)) {
        this.#loadLevel(this.levelIndex);
      }
      this.player.hp = Math.max(1, Math.min(100, data.hp || 100));
      this.currentWeaponId = data.currentWeaponId || "ar";
      this.weapons.ar.mag = data.weapons?.ar?.mag ?? this.weapons.ar.mag;
      this.weapons.ar.reserve = data.weapons?.ar?.reserve ?? this.weapons.ar.reserve;
      this.weapons.ar.unlocked = data.weapons?.ar?.unlocked ?? this.weapons.ar.unlocked;
      this.weapons.m6d.mag = data.weapons?.m6d?.mag ?? this.weapons.m6d.mag;
      this.weapons.m6d.reserve = data.weapons?.m6d?.reserve ?? this.weapons.m6d.reserve;
      this.weapons.m6d.unlocked = data.weapons?.m6d?.unlocked ?? this.weapons.m6d.unlocked;
      this.weapons.shotgun.mag = data.weapons?.shotgun?.mag ?? this.weapons.shotgun.mag;
      this.weapons.shotgun.reserve = data.weapons?.shotgun?.reserve ?? this.weapons.shotgun.reserve;
      this.weapons.shotgun.unlocked = data.weapons?.shotgun?.unlocked ?? this.weapons.shotgun.unlocked;
      this.weapons.plasma.mag = data.weapons?.plasma?.mag ?? this.weapons.plasma.mag;
      this.weapons.plasma.reserve = data.weapons?.plasma?.reserve ?? this.weapons.plasma.reserve;
      this.weapons.plasma.unlocked = data.weapons?.plasma?.unlocked ?? this.weapons.plasma.unlocked;
      this.weapons.grenade.mag = data.weapons?.grenade?.mag ?? this.weapons.grenade.mag;
      this.weapons.grenade.reserve = data.weapons?.grenade?.reserve ?? this.weapons.grenade.reserve;
      this.weapons.grenade.unlocked = data.weapons?.grenade?.unlocked ?? this.weapons.grenade.unlocked;
      this.weapons.sniper.mag = data.weapons?.sniper?.mag ?? this.weapons.sniper.mag;
      this.weapons.sniper.reserve = data.weapons?.sniper?.reserve ?? this.weapons.sniper.reserve;
      this.weapons.sniper.unlocked = data.weapons?.sniper?.unlocked ?? this.weapons.sniper.unlocked;
      if (!this.weapons[this.currentWeaponId]?.unlocked) {
        this.currentWeaponId = this.weapons.ar.unlocked ? "ar" : this.weapons.shotgun.unlocked ? "shotgun" : "m6d";
      }
      this.hud.updateHealth(this.player.hp);
      this.hud.updateKeycards(this.collectedKeys);
      this.#syncJournalHud();
      this.#updateWeaponViewModelVisibility();
      this.#syncHudAmmo();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  #onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  #animate() {
    requestAnimationFrame(() => this.#animate());
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrameAt) * 0.001);
    this.lastFrameAt = now;

    if (this.gameStarted) {
      this.fireCooldown = Math.max(0, this.fireCooldown - dt);
      this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);
      if (this.reloadTimer === 0 && this.reloadTargetWeaponId) {
        this.reloadTimeouts.length = 0;
        this.#finishReload();
      }
      if (this.input.fireHeld && this.currentWeaponId === "ar") {
        this.#tryFireClick();
      }
      this.weapons.grenade.pumpTimer = Math.max(0, this.weapons.grenade.pumpTimer - dt);
      this.weapons.sniper.pumpTimer = Math.max(0, this.weapons.sniper.pumpTimer - dt);
      this.#updatePlasma(dt);
      this.#updateRecoil(dt);
      this.#updateMuzzleFlash();
      this.#updateCameraShake(dt);
      this.#updateShieldRecharge(dt);
      this.#updatePlayerMovement(dt);
      this.#updateDoors(dt);
      this.#updatePickups();
      this.#updateInteractables(dt);
      this.#updateEnemyAI(dt);
      this.#updateProjectiles(dt);
      this.#updateGibs(dt);
      this.#updateSparks(dt);
      this.#updateShellCasings(dt);
      this.#updateCrates(dt);
      if (this.levelIndex === 3) this.#updateRiftEffects(dt);
      this.#updateFlickerAndAlarms(dt);
      this.#updateTracker(dt);
      this.#updateDoorsExitLogic();
      this.#updateLevelAmbientEvents(dt);
      if (this.player.dead && this.deathCinematicTimer > 0) this.#updateDeathCinematic(dt);
      this.hud.updateDamage(dt);
      this.audio.update(dt);

      if (this.currentWeaponId === "plasma" && !this.input.fireHeld) {
        this.weapons.plasma.burstShotsQueued = 0;
      }
    }

    this.composer.render();
  }
}
