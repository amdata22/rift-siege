import { describe, expect, it } from "vitest";
import { GAME_CONFIG, DIFFICULTIES, MATERIAL_PRESETS } from "../config.js";

describe("enemy stats", () => {
  it("all enemy types have positive hp", () => {
    for (const [, stats] of Object.entries(GAME_CONFIG.enemyStats)) {
      expect(stats.hp).toBeGreaterThan(0);
    }
  });

  it("enemy hp scales correctly with easy difficulty", () => {
    const mult = DIFFICULTIES.easy.enemyHpMultiplier;
    for (const [, stats] of Object.entries(GAME_CONFIG.enemyStats)) {
      const scaled = Math.round(stats.hp * mult);
      expect(scaled).toBeLessThan(stats.hp + 1); // easy has less hp
    }
  });

  it("easy enemy hp is less than hard enemy hp", () => {
    const easyMult = DIFFICULTIES.easy.enemyHpMultiplier;
    const hardMult = DIFFICULTIES.hard.enemyHpMultiplier;
    for (const [, stats] of Object.entries(GAME_CONFIG.enemyStats)) {
      expect(stats.hp * easyMult).toBeLessThan(stats.hp * hardMult);
    }
  });

  it("brute has the highest base hp", () => {
    const hps = Object.values(GAME_CONFIG.enemyStats).map((s) => s.hp);
    expect(GAME_CONFIG.enemyStats.brute.hp).toBe(Math.max(...hps));
  });

  it("all enemies have a defined headHeight > 0", () => {
    for (const [, stats] of Object.entries(GAME_CONFIG.enemyStats)) {
      expect(stats.headHeight).toBeGreaterThan(0);
    }
  });
});

describe("material presets", () => {
  it("all presets have a color that is a non-negative number", () => {
    for (const [, preset] of Object.entries(MATERIAL_PRESETS)) {
      expect(typeof preset.color).toBe("number");
      expect(preset.color).toBeGreaterThanOrEqual(0);
    }
  });

  it("metalness values are in [0, 1]", () => {
    for (const [, preset] of Object.entries(MATERIAL_PRESETS)) {
      if (preset.metalness == null) continue;
      expect(preset.metalness).toBeGreaterThanOrEqual(0);
      expect(preset.metalness).toBeLessThanOrEqual(1);
    }
  });

  it("roughness values are in [0, 1]", () => {
    for (const [, preset] of Object.entries(MATERIAL_PRESETS)) {
      if (preset.roughness == null) continue;
      expect(preset.roughness).toBeGreaterThanOrEqual(0);
      expect(preset.roughness).toBeLessThanOrEqual(1);
    }
  });

  it("wall and floor have the same color (station aesthetic)", () => {
    expect(MATERIAL_PRESETS.wall.color).toBe(MATERIAL_PRESETS.floor.color);
  });
});

describe("difficulty balance", () => {
  it("hard difficulty has higher enemy hp multiplier than easy", () => {
    expect(DIFFICULTIES.hard.enemyHpMultiplier).toBeGreaterThan(DIFFICULTIES.easy.enemyHpMultiplier);
  });

  it("easy difficulty has higher health pickup multiplier than hard", () => {
    expect(DIFFICULTIES.easy.healthPickupMultiplier).toBeGreaterThan(DIFFICULTIES.hard.healthPickupMultiplier);
  });

  it("only easy and normal allow manual saves", () => {
    expect(DIFFICULTIES.easy.allowManualSave).toBe(true);
    expect(DIFFICULTIES.normal.allowManualSave).toBe(true);
    expect(DIFFICULTIES.hard.allowManualSave).toBe(false);
  });

  it("player takes more damage on hard than easy", () => {
    expect(DIFFICULTIES.hard.playerDamageTakenMultiplier).toBeGreaterThan(
      DIFFICULTIES.easy.playerDamageTakenMultiplier
    );
  });
});
