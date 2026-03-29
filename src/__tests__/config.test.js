import { describe, expect, it } from "vitest";
import { DIFFICULTIES, GAME_CONFIG, STORAGE_KEY } from "../config.js";

describe("config integrity", () => {
  it("exposes expected difficulties", () => {
    expect(Object.keys(DIFFICULTIES)).toEqual(["easy", "normal", "hard"]);
    for (const difficulty of Object.values(DIFFICULTIES)) {
      expect(typeof difficulty.label).toBe("string");
      expect(difficulty.label.length).toBeGreaterThan(0);
      expect(difficulty.enemyHpMultiplier).toBeGreaterThan(0);
      expect(difficulty.playerDamageTakenMultiplier).toBeGreaterThan(0);
      expect(typeof difficulty.allowManualSave).toBe("boolean");
    }
  });

  it("keeps weapon config values sane", () => {
    const weaponEntries = Object.entries(GAME_CONFIG.weapons);
    expect(weaponEntries.length).toBeGreaterThan(0);

    for (const [weaponId, weapon] of weaponEntries) {
      expect(weapon.id).toBe(weaponId);
      expect(typeof weapon.name).toBe("string");
      expect(weapon.name.length).toBeGreaterThan(0);
      if (typeof weapon.magSize === "number") {
        expect(weapon.magSize).toBeGreaterThan(0);
      }
      if (typeof weapon.damage === "number") {
        expect(weapon.damage).toBeGreaterThan(0);
      }
    }
  });

  it("uses a non-empty localStorage key", () => {
    expect(typeof STORAGE_KEY).toBe("string");
    expect(STORAGE_KEY.length).toBeGreaterThan(0);
  });
});
