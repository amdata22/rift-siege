import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../config.js";
import { LEVELS } from "../levelData.js";
import { splashFalloff } from "../utils.js";

const ROOM_STEP = 12;
const DOOR_WIDTH = 2;

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
