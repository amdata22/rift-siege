# Alien X - Modern Remake (Browser FPS)

Modern browser-first remake foundation inspired by Alien X (2001), with Three.js WebGL rendering and fast, corridor-based room-clearing combat.

## Run

Install deps and run Vite:

- `npm install`
- `npm run dev -- --host 127.0.0.1 --port 5173`
- Open [http://127.0.0.1:5173](http://127.0.0.1:5173)

## Current implementation

- Three.js runtime with ACES tone mapping, SRGB output, PCF soft shadows.
- Post stack with `EffectComposer`: `RenderPass -> SSAOPass -> UnrealBloomPass -> OutputPass`.
- Pointer-lock FPS controls, WASD movement, crouch, no jump.
- Capsule-like player-vs-AABB wall collision.
- Head bob + footstep timing at bob peaks.
- M6D pistol implemented with:
  - semi-auto click fire
  - 12-round mag + reserve
  - ADS FOV lerp (75 -> 55)
  - recoil phase animation
  - damage falloff (18m to 40m, to 40% damage)
  - reload timeline and empty click behavior
- Secondary weapons implemented:
  - Plasma Rifle burst logic + overheat cooldown
  - Grenade Launcher arc projectile + AoE damage
- Enemy system with state machine skeleton:
  - Shamblers (alert chain + melee)
  - Crawlers (pounce + corpse reanimation pressure)
  - Brutes (spit projectile + melee + stagger reactions)
- Four-level progression with room chains, locked doors, keycards, pickups, and final rift anchors.
- Scripted encounter layer (second pass):
  - Level 1 vent-burst Crawler ambush after skittering warning cue
  - Level 2 arena prewarning blips, then Brute + Shambler wave trigger
  - Brute guard-room leash behavior around keycard rooms
- HUD:
  - segmented health bar and low-health vignette
  - ammo display + low ammo flash
  - keycard badges
  - motion tracker (1Hz updates, hidden during ADS)
  - crosshair behaviors and damage direction indicator
- Manual save slot (`F5`) on Easy/Normal via `localStorage`.

## Notes

- Art/audio assets are currently placeholder primitives and synthesized Web Audio tones, but systems are wired for easy asset replacement.
- Ambient storytelling pass includes simple desks/lockers/mugs/screen props, broadcast screen glitches, random PA static, and a persistent Level 2 phone ring motif.
- Enemy pathing uses direct pursuit and room-centric behavior suitable for modular AABB corridors (no navmesh required).
