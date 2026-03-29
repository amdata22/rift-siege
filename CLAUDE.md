# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Vite dev server
npm run build        # Production build (outputs to /dist)
npm run preview      # Preview production build
npm test             # Run tests once
npm run test:watch   # Run tests in watch mode
npx vitest run src/__tests__/config.test.js  # Run a single test file
```

## Architecture

Rift Siege is a browser-based first-person shooter built with Three.js (0.183), three-mesh-bvh (BVH-accelerated raycasting), and Vite (JavaScript, no TypeScript).

**Three layers:**
- **Data layer:** `src/config.js` (all tunable constants), `src/levelData.js` (4 level definitions), `src/journalData.js` (10 story log entries)
- **Simulation layer:** `src/game.js` (~4100 lines) — the entire game class (`RiftSiegeGame`), including the render loop, player movement/collision, weapon system, enemy AI state machines, level generation, and save/load
- **Presentation layer:** `src/hud.js` (DOM + canvas HUD), `src/audio.js` (Web Audio synthesis), `src/styles.css`

Entry point: `index.html` → `src/main.js` → instantiates `RiftSiegeGame`.

## Key Systems in game.js

**Player:** First-person capsule (radius 0.35, eye height 1.75). WASD + pointer lock. States: normal, crouch, knockback, stun, grab. Shield absorbs damage first, recharges after 4s of no damage at 15 pts/sec.

**Weapons:** 6 weapons — AR (auto), M6D Magnum (semi), Shotgun (pellets), Plasma Rifle (burst/overheat), Grenade Launcher (arc projectile), Sniper (scope zoom, pump delay). Hitscan hit detection with distance falloff; grenades use physics arc. All stats in `config.js` under `WEAPONS`.

**Enemy AI:** String-based state machine (`PATROL → ALERT → ATTACK`), no library. Four enemy types:
- **Shamblers** (melee lurkers) — hobble movement, alert nearby on moan
- **Crawlers** (fast) — sprint-chase, 2-hit combo, reanimate fresh corpses within 20s
- **Brutes** (heavy, 330 HP) — guard specific rooms, grab/haymaker/shove attack modes, position-locked until engaged
- **Reanimated** (revived corpses via crawler)

Stats in `config.js` under `ENEMIES`.

**Levels:** AABB-based room geometry on a 12m grid. Color-keyed locked doors (blue/green/orange/red). Level 4 has rift anchor destruction objectives (hold E 2s × 3 anchors, requires all brutes dead).

**Save system:** `localStorage` key `"rift-siege-save-slot-v1"`. Saves level index, difficulty, HP, weapon inventory (mag/reserve/unlocked per weapon), keycards, journal IDs. Hard mode disables manual save (F5).

**Post-processing pipeline:** RenderPass → SSAOPass → UnrealBloomPass → OutputPass.

**Audio:** Entirely procedural (Web Audio API, no sample files). Ambient music layers blend dynamically; combat mix fades in when enemies are ALERT/ATTACK. Low-pass filter drops to 800 Hz when player HP < 20.

## Tests

Tests live in `src/__tests__/` and validate data integrity only (config shape, level authoring rules, journal ID uniqueness). No AI or combat flow is tested.

## Tuning and Balance

All gameplay numbers (weapon damage/fire rate/ammo, enemy HP/speed/damage, difficulty multipliers, pickup values) live in `src/config.js`. Edit there first before touching `game.js` logic.

Difficulty scales via multipliers only (same content, scaled stats). Key per-difficulty differences: `motionTrackerRange` (20/14/10m easy/normal/hard), `allowManualSave` (false on hard), `crawlerSpeed` (6.5 on hard vs 5.5).

## Non-obvious Patterns

- **Enemy culling:** Enemies >30m away skip AI update unless ALERT/ATTACK state.
- **Brute guard rooms:** Brutes are position-locked to specific rooms and path back if >9m away when not attacking.
- **Crawler reanimation window:** Corpses are only reanimatable for 20s after death. Corpse is marked `used` after reanimation.
- **Muzzle flash:** A `PointLight` is added and removed each frame — it's intentionally one-frame only.
- **Sniper/Grenade pump timer:** Weapon is completely locked during `pumpTimer` after each shot.
- **Plasma overheat:** Tracked by burst count (max 24), not time. Cooldown is 2.5s after overheat.
- **Intro sentinel:** Level 1's first shambler starts IDLE, transitions to ALERT only on room 1 entry or sight.
- **Grab mash meter:** Player must press fast repeatedly to accumulate a velocity-based mash meter ≥ 8 to break free.
- **Hit detection order:** Raycast checks enemy spheres first, then walls — enemy only takes damage if closer than the nearest wall hit.
- **Headshot zone:** `hitPoint.y > enemyMeshPos.y + stats.headHeight * 0.5` → 1.45× damage multiplier.
- **Death mode selection:** Driven by overkill ratio and `dismemberChance[type]` in config — adjust config before touching `#damageEnemy()`.
