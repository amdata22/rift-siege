import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../config.js";
import { damageWithFalloff, clamp01, rand } from "../utils.js";

// ── damageWithFalloff ───────────────────────────────────────────────────────

describe("damageWithFalloff", () => {
  it("returns full damage at or below falloff start", () => {
    expect(damageWithFalloff(100, 0, 20, 50, 0.5)).toBe(100);
    expect(damageWithFalloff(100, 20, 20, 50, 0.5)).toBe(100);
  });

  it("returns min multiplier damage at or beyond falloff end", () => {
    expect(damageWithFalloff(100, 50, 20, 50, 0.5)).toBe(50);
    expect(damageWithFalloff(100, 99, 20, 50, 0.5)).toBe(50);
  });

  it("linearly interpolates damage between start and end", () => {
    // midpoint of [20, 50] → t=0.5 → 100 * (1 + (0.5-1)*0.5) = 100 * 0.75 = 75
    expect(damageWithFalloff(100, 35, 20, 50, 0.5)).toBeCloseTo(75, 5);
  });

  it("handles zero falloff range gracefully (start === end)", () => {
    const val = damageWithFalloff(100, 30, 30, 30, 0.4);
    expect(val).toBeGreaterThanOrEqual(40);
    expect(val).toBeLessThanOrEqual(100);
  });
});

// ── clamp01 ─────────────────────────────────────────────────────────────────

describe("clamp01", () => {
  it("clamps below 0", () => expect(clamp01(-5)).toBe(0));
  it("clamps above 1", () => expect(clamp01(2)).toBe(1));
  it("passes values in [0,1] unchanged", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });
});

// ── rand ────────────────────────────────────────────────────────────────────

describe("rand", () => {
  it("returns values within [min, max)", () => {
    for (let i = 0; i < 200; i += 1) {
      const v = rand(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
    }
  });
});

// ── Weapon config completeness ───────────────────────────────────────────────

describe("weapon config completeness", () => {
  const weaponEntries = Object.entries(GAME_CONFIG.weapons);

  it("all weapons have a damage value > 0", () => {
    for (const [id, w] of weaponEntries) {
      if (id === "grenade") continue; // grenade uses radius splash
      expect(typeof w.damage).toBe("number");
      expect(w.damage).toBeGreaterThan(0);
    }
  });

  it("all weapons with ADS have a defined adsSpreadDeg", () => {
    for (const [, w] of weaponEntries) {
      if (!w.canAds) continue;
      expect(typeof w.adsSpreadDeg).toBe("number");
      expect(w.adsSpreadDeg).toBeGreaterThanOrEqual(0);
    }
  });

  it("all weapons with falloff have start < end and valid multiplier", () => {
    for (const [, w] of weaponEntries) {
      if (w.falloffStart == null) continue;
      expect(w.falloffStart).toBeGreaterThanOrEqual(0);
      expect(w.falloffEnd).toBeGreaterThan(w.falloffStart);
      expect(w.falloffMinMultiplier).toBeGreaterThan(0);
      expect(w.falloffMinMultiplier).toBeLessThan(1);
    }
  });

  it("shotgun has a pellets count >= 4", () => {
    expect(GAME_CONFIG.weapons.shotgun.pellets).toBeGreaterThanOrEqual(4);
  });

  it("sniper rifle has longer range than AR", () => {
    expect(GAME_CONFIG.weapons.sniper.falloffEnd).toBeGreaterThan(
      GAME_CONFIG.weapons.ar.falloffEnd
    );
  });

  it("sniper rifle deals more damage per shot than AR", () => {
    expect(GAME_CONFIG.weapons.sniper.damage).toBeGreaterThan(
      GAME_CONFIG.weapons.ar.damage
    );
  });
});

// ── Shield config ────────────────────────────────────────────────────────────

describe("shield config", () => {
  it("has positive maxShield", () => {
    expect(GAME_CONFIG.player.maxShield).toBeGreaterThan(0);
  });

  it("has a positive recharge delay", () => {
    expect(GAME_CONFIG.player.shieldRechargeDelay).toBeGreaterThan(0);
  });

  it("has a positive recharge rate", () => {
    expect(GAME_CONFIG.player.shieldRechargeRate).toBeGreaterThan(0);
  });
});

// ── Sprint config ────────────────────────────────────────────────────────────

describe("sprint config", () => {
  it("sprint speed multiplier is above 1", () => {
    expect(GAME_CONFIG.player.sprintSpeedMultiplier).toBeGreaterThan(1);
  });

  it("sprint FOV is greater than default FOV", () => {
    expect(GAME_CONFIG.player.sprintFov).toBeGreaterThan(GAME_CONFIG.player.fov);
  });
});

// ── Melee config ─────────────────────────────────────────────────────────────

describe("melee config", () => {
  it("melee damage is positive", () => {
    expect(GAME_CONFIG.player.meleeDamage).toBeGreaterThan(0);
  });

  it("melee range is greater than 0.5 m", () => {
    expect(GAME_CONFIG.player.meleeRange).toBeGreaterThan(0.5);
  });

  it("melee cooldown is positive", () => {
    expect(GAME_CONFIG.player.meleeCooldown).toBeGreaterThan(0);
  });
});

// ── Shield absorption logic (pure simulation) ────────────────────────────────

describe("shield absorption logic", () => {
  it("shield absorbs damage before HP is reduced", () => {
    let hp = 100;
    let shield = 50;
    const damage = 30;

    const absorbed = Math.min(shield, damage);
    shield -= absorbed;
    hp -= (damage - absorbed);

    expect(shield).toBe(20);
    expect(hp).toBe(100);
  });

  it("overpenetrating damage bleeds through to HP", () => {
    let hp = 100;
    let shield = 20;
    const damage = 50;

    const absorbed = Math.min(shield, damage);
    shield -= absorbed;
    hp -= (damage - absorbed);

    expect(shield).toBe(0);
    expect(hp).toBe(70);
  });

  it("with no shield all damage hits HP", () => {
    let hp = 100;
    let shield = 0;
    const damage = 40;

    const absorbed = Math.min(shield, damage);
    shield -= absorbed;
    hp -= (damage - absorbed);

    expect(shield).toBe(0);
    expect(hp).toBe(60);
  });

  it("shield recharges at the configured rate per second", () => {
    let shield = 0;
    const maxShield = GAME_CONFIG.player.maxShield;
    const rate = GAME_CONFIG.player.shieldRechargeRate;
    const dt = 1.0;

    shield = Math.min(maxShield, shield + rate * dt);

    expect(shield).toBeCloseTo(rate, 5);
    expect(shield).toBeLessThanOrEqual(maxShield);
  });
});
