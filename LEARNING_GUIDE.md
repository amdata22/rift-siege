# Rift Siege Learning Guide (Intermediate Dev)

This file explains how the current game is structured, why the systems are written this way, and how to extend them safely.

If you read this while stepping through the code in your editor, focus on `src/game.js` first, then `src/config.js`, `src/hud.js`, and `src/audio.js`.

---

## 1) Project structure

- `src/main.js`  
  Entry point. Creates `RiftSiegeGame`, handles startup/fatal error reporting.

- `src/game.js`  
  Core game class (`RiftSiegeGame`) with rendering, level generation, controls, weapons, enemies, AI, collisions, and the game loop.

- `src/config.js`  
  Tunable constants: difficulty, weapon stats, enemy stats, material presets, renderer settings.

- `src/levelData.js`  
  Per-level content setup (enemy counts, keycards, ambience type, final anchors).

- `src/journalData.js`  
  Story logs (datapad pickups): ordered entries with escalating tone; spawned randomly per level in `RiftSiegeGame.#spawnJournalPickups()`.

- `src/hud.js`  
  Pure DOM/canvas HUD layer (health, ammo, crosshair, tracker, interaction prompts).

- `src/audio.js`  
  Web Audio tone-based placeholder SFX/music manager.

---

## 2) Boot flow and game lifecycle

### Startup
1. `src/main.js` creates `new RiftSiegeGame(app)` and calls `init()`.
2. `init()` in `src/game.js` builds:
   - renderer + post FX composer
   - scene + camera + pointer lock controls
   - viewmodel(s)
   - HUD/menu
   - input listeners
3. Start menu is shown and render loop begins.

### Start game
When difficulty button is clicked:
- `#startGame()` resets player/weapons/state.
- `#loadLevel()` builds geometry and systems for the chosen level.
- pointer lock is engaged.

### Core loop
`#animate()` runs each frame and calls update subsystems in order:
- timers/reload/cooldowns
- weapon fire logic
- movement + collision
- doors/pickups/interactables
- enemy AI
- projectiles
- lighting/event systems
- HUD/audio updates
- composer render

This single-loop architecture keeps state changes predictable.

---

## 3) Rendering and visual pipeline

Renderer setup in `#initRenderer()`:
- `WebGLRenderer({ antialias: true })`
- ACES tone mapping
- SRGB output
- soft shadows

Post-processing in `#initScene()`:
- `RenderPass`
- `SSAOPass`
- `UnrealBloomPass`
- `OutputPass`

Important: most brightness/contrast feel comes from:
- `GAME_CONFIG.renderer.exposure`
- `ssaoIntensity`
- light rig values in `mapRoomTone()`

If visuals feel too crushed, reduce AO before pushing exposure higher.

---

## 4) Level generation: now “rail-shootery” with winding halls

The straight chain layout was replaced by a guided turn-heavy path:

- `#generateRailRooms(roomCount)`
  - builds a non-overlapping path on a grid
  - forward-biased turning (feels directed)
  - corridor-heavy room sizing with occasional arena spaces

- `#sideFromTo(fromRoom, toRoom)`
  - derives directional relation (`north/south/east/west`)
  - used by wall-hole and door placement logic

- `#buildRoomsAndDoors()`
  - opens only walls that connect to previous/next room
  - places doors at correct midpoint for either horizontal or vertical transitions

This gives a “keep moving forward through bends” pacing without needing a full navmesh.

---

## 5) Player movement and collision

### Input
Keyboard/mouse listeners are in `#initEvents()`.  
Movement flags (`forward/backward/left/right`) are sampled each frame.

### Movement
`#updatePlayerMovement(dt)`:
- converts input to camera-relative velocity
- applies crouch and head bob
- updates ADS FOV transitions
- handles knockback/stun/grab constraints

### Collision
- Player uses capsule-like radius vs AABB world bounds in `#resolvePlayerWallCollision()`.
- Enemies use similar radius pushes via `#resolveEnemyWallCollision(enemy)`.

This is simple and fast for corridor shooters.

---

## 6) Weapon system architecture

Weapons live in `this.weapons` dictionary and are stat-driven from `src/config.js`.

Current loadout:
- `ar` = starting primary (auto fire)
- `m6d` = starting secondary (semi auto)
- plus unlockable plasma/grenade

### Key methods
- `#switchWeapon(id)`
- `#tryFireClick()`
- `#fireAssaultRifle()`
- `#fireM6D()`
- `#fireGrenade()`
- `#updatePlasma(dt)`
- `#doHitscanShot(weapon)`

Hit detection is hitscan + sphere approximations for enemies and raycast checks vs walls/doors.

---

## 7) Enemy AI/state model

Each enemy is an `Enemy` object (class near top of `src/game.js`) with:
- HP/states/timers
- movement vectors
- attack phase data

### Crawler (updated)
- no pounce now
- upright biped, walk then sudden sprint near player
- double-swipe combo attack
- retains reanimation pressure mechanic

### Brute (updated)
- melee-only now (no spit/projectiles)
- haymaker windup/strike/recovery
- shove with knockback/stun
- low-HP grab with mash escape and post-break stagger

### AI update
`#updateEnemyAI(dt)` dispatches by enemy type to:
- `#updateShambler()`
- `#updateCrawler()`
- `#updateBrute()`

---

## 8) HUD and UI

`src/hud.js` handles DOM/canvas updates only (no game rules).  
Game state is pushed into HUD through methods like:
- `updateHealth()`
- `updateAmmo()`
- `updateCrosshair()`
- `drawTracker()`
- `showInteract()/hideInteract()`

This separation makes it easier to restyle HUD without touching gameplay logic.

---

## 9) Audio design (placeholder but structured)

`src/audio.js` uses Web Audio oscillators as stand-ins for real assets.

Why this is useful:
- you can iterate gameplay timing now
- swap to actual samples later without rewriting game logic

The game calls semantic methods (`playM6DFire`, `playShamblerMoan`, etc.) instead of raw oscillator code.

---

## 10) Save system

- one localStorage slot (`STORAGE_KEY`)
- save/load in `#manualSave()` and `#tryLoadManualSave()`
- includes level index, difficulty, keys, weapon inventories/current weapon

Good next step: version the save payload so future schema changes do not break old saves.

---

## 11) How to safely modify systems

When changing behavior, prefer this order:
1. Update stat knobs in `src/config.js`.
2. If needed, update logic in one focused method in `src/game.js`.
3. Run quick checks (`node --check`) and test in-game.

For enemy changes, edit:
- stats in `config.js`
- the specific `#update<Type>()` method
- optional mesh style in `#spawnEnemyMesh()`

For weapon additions:
1. add config entry
2. add runtime object in constructor
3. add fire/update method
4. wire keybinding/switch order
5. include save/load fields

---

## 12) Suggested learning exercises (practical)

1. Add a stamina system for sprinting.
2. Add weak-point multipliers per enemy type.
3. Add a debug overlay with FPS/enemy count/current state.
4. Add “encounter seeds” so generated layouts are reproducible.
5. Replace one placeholder enemy mesh with a loaded GLTF model.

---

## 13) Mental model to keep

Think of this game as three layers:
- **Data layer:** `config.js`, `levelData.js`
- **Simulation layer:** `game.js` update methods
- **Presentation layer:** renderer/HUD/audio

When bugs happen, first identify which layer is wrong.  
That alone makes debugging much faster.

