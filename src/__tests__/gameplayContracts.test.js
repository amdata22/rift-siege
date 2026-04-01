import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../config.js";
import { LEVELS } from "../levelData.js";
import { splashFalloff } from "../utils.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOM_STEP = 12;
const DOOR_WIDTH = 2;
const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_SOURCE = readFileSync(resolve(__dirname, "../game.js"), "utf8");

function sideFromTo(fromRoom, toRoom) {
  const dx = toRoom.x * ROOM_STEP - fromRoom.x * ROOM_STEP;
  const dz = toRoom.z * ROOM_STEP - fromRoom.z * ROOM_STEP;
  if (Math.abs(dx) > Math.abs(dz)) {
    return dx > 0 ? "east" : "west";
  }
  return dz > 0 ? "north" : "south";
}

function overlap1D(minA, maxA, minB, maxB) {
  return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
}

describe("spawn spacing contracts", () => {
  it("defines min spawn spacing for enemy types", () => {
    const minSpacing = GAME_CONFIG.gameplayTuning.spawnSpacing.minSpawnSpacing;
    expect(minSpacing).toBeDefined();
    expect(minSpacing.default).toBeGreaterThanOrEqual(0.3);
    expect(minSpacing.default).toBeLessThanOrEqual(0.4);
    expect(minSpacing.crawler).toBeGreaterThanOrEqual(minSpacing.default);
    expect(minSpacing.brute).toBeGreaterThan(minSpacing.crawler);
  });
});

describe("grenade splash contracts", () => {
  it("stays within [minMultiplier, 1] and falls off with distance", () => {
    const radius = 2.5;
    const minMult = 0.2;
    const center = splashFalloff(0, radius, minMult);
    const mid = splashFalloff(radius * 0.5, radius, minMult);
    const edge = splashFalloff(radius, radius, minMult);
    const beyond = splashFalloff(radius * 2, radius, minMult);

    expect(center).toBe(1);
    expect(mid).toBeGreaterThan(edge);
    expect(edge).toBe(minMult);
    expect(beyond).toBe(minMult);
  });

  it("handles invalid radius safely", () => {
    expect(splashFalloff(1, 0, 0.2)).toBe(0.2);
    expect(splashFalloff(1, -5, 0.2)).toBe(0.2);
  });
});

describe("room connector overlap contracts", () => {
  it("keeps consecutive authored rooms wide enough for door-aligned connectors", () => {
    for (const level of LEVELS) {
      for (let i = 0; i < level.rooms.length - 1; i += 1) {
        const from = level.rooms[i];
        const to = level.rooms[i + 1];
        const side = sideFromTo(from, to);

        if (side === "north" || side === "south") {
          const fromMinX = from.x * ROOM_STEP - from.width * 0.5;
          const fromMaxX = from.x * ROOM_STEP + from.width * 0.5;
          const toMinX = to.x * ROOM_STEP - to.width * 0.5;
          const toMaxX = to.x * ROOM_STEP + to.width * 0.5;
          const sharedWidth = overlap1D(fromMinX, fromMaxX, toMinX, toMaxX);
          expect(sharedWidth).toBeGreaterThanOrEqual(DOOR_WIDTH);
        } else {
          const fromMinZ = from.z * ROOM_STEP - from.depth * 0.5;
          const fromMaxZ = from.z * ROOM_STEP + from.depth * 0.5;
          const toMinZ = to.z * ROOM_STEP - to.depth * 0.5;
          const toMaxZ = to.z * ROOM_STEP + to.depth * 0.5;
          const sharedDepth = overlap1D(fromMinZ, fromMaxZ, toMinZ, toMaxZ);
          expect(sharedDepth).toBeGreaterThanOrEqual(DOOR_WIDTH);
        }
      }
    }
  });
});

describe("rift anchor contracts", () => {
  it("keeps anchor hp tuned to a 3-4 AR burst", () => {
    const arDamage = GAME_CONFIG.weapons.ar.damage;
    const anchorHp = 100;
    const shotsToKill = Math.ceil(anchorHp / arDamage);
    expect(shotsToKill).toBeGreaterThanOrEqual(3);
    expect(shotsToKill).toBeLessThanOrEqual(4);
  });

  it("shows HUD anchor-hit feedback when anchor damage is applied", () => {
    expect(GAME_SOURCE).toContain("#damageAnchor(anchor, amount, hitPoint = null)");
    expect(GAME_SOURCE).toContain("anchor.hitFlashTimer = 0.14;");
    expect(GAME_SOURCE).toContain("this.hud.showAnchorHit();");
  });
});

describe("continue flow contracts", () => {
  it("attempts manual save load before fallback level load", () => {
    const continueBranch = /if \(options\.continueFromSave\) \{([\s\S]*?)\} else \{/m.exec(GAME_SOURCE)?.[1] || "";
    expect(continueBranch).toContain("const loaded = this.#tryLoadManualSave();");
    expect(continueBranch).toContain("if (!loaded) this.#loadLevel(this.levelIndex);");
  });

  it("returns boolean status from manual save loader", () => {
    expect(GAME_SOURCE).toContain("#tryLoadManualSave() {");
    expect(GAME_SOURCE).toContain("if (!this.difficulty.allowManualSave) return false;");
    expect(GAME_SOURCE).toContain("if (!raw) return false;");
    expect(GAME_SOURCE).toContain("return true;");
  });
});
