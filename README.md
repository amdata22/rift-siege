# Rift Siege (Browser FPS)

Browser-first sci-fi FPS built with Three.js and fast, corridor-based room-clearing combat.

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

## Deploy To Production

### Option 1: Vercel (fastest)

1. Push this repo to GitHub.
2. In Vercel, click New Project and import the repo.
3. Keep default settings (framework: Vite).
4. Deploy.

This project includes Vercel config in [vercel.json](vercel.json).

### Option 2: Netlify

1. Push this repo to GitHub.
2. In Netlify, click Add new site -> Import an existing project.
3. Build command: npm run build
4. Publish directory: dist
5. Deploy.

This project includes Netlify config in [netlify.toml](netlify.toml).

## How To Play

### Play online

Deploy the project (Vercel or Netlify above) and share the production URL. Players can open that URL in any modern desktop browser.

### Play locally

1. `npm install`
2. `npm run dev`
3. Open the local URL shown in the terminal (usually `http://127.0.0.1:5173`)

### Controls

- `W/A/S/D`: move
- `Mouse`: look / aim
- `Left click`: fire
- `Right click`: aim down sights (where supported)
- `R`: reload
- `Shift`: sprint
- `C`: crouch
- `E`: interact
- `1-6`: weapon select
- `Mouse wheel`: cycle weapons
- `F`: melee
- `J`: toggle journal log
- `F5`: manual save (Easy/Normal)

### Objective

Fight through four levels, clear encounters, collect keycards to open locked doors, and complete level objectives to progress.
