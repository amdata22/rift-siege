import { describe, expect, it } from "vitest";
import { LEVELS } from "../levelData.js";

describe("level authoring integrity", () => {
  it("has unique level ids and room counts that match", () => {
    const ids = new Set();
    for (const level of LEVELS) {
      expect(ids.has(level.id)).toBe(false);
      ids.add(level.id);
      expect(Array.isArray(level.rooms)).toBe(true);
      expect(level.rooms.length).toBe(level.roomCount);
      expect(level.rooms.length).toBeGreaterThan(0);
    }
  });

  it("keeps keycard and locked door room references valid", () => {
    for (const level of LEVELS) {
      const keyColors = new Set((level.keycards || []).map((item) => item.color));
      for (const card of level.keycards || []) {
        expect(card.room).toBeGreaterThanOrEqual(0);
        expect(card.room).toBeLessThan(level.rooms.length);
      }
      for (const door of level.lockedDoors || []) {
        expect(door.room).toBeGreaterThanOrEqual(0);
        expect(door.room).toBeLessThan(level.rooms.length);
        expect(keyColors.has(door.color)).toBe(true);
      }
    }
  });

  it("keeps enemy counts non-negative", () => {
    for (const level of LEVELS) {
      for (const count of Object.values(level.enemies || {})) {
        expect(typeof count).toBe("number");
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
