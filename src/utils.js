/** Returns a random float in [min, max). */
export function rand(min, max) {
  return min + Math.random() * (max - min);
}

/** Clamps v to [0, 1]. */
export function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/** Clamps v to [min, max]. */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Applies linear damage falloff between start and end distance.
 * At distance <= start: full damage. At distance >= end: baseDamage * minMultiplier.
 */
export function damageWithFalloff(baseDamage, distance, start, end, minMultiplier) {
  if (distance <= start) return baseDamage;
  if (distance >= end) return baseDamage * minMultiplier;
  const t = (distance - start) / (end - start);
  return baseDamage * (1 + (minMultiplier - 1) * t);
}

/** 2D planar distance on XZ plane between objects/vectors with x and z values. */
export function planarDistanceXZ(a, b) {
  const dx = (a?.x ?? 0) - (b?.x ?? 0);
  const dz = (a?.z ?? 0) - (b?.z ?? 0);
  return Math.hypot(dx, dz);
}

/**
 * Normalized splash multiplier from 1.0 (center) to minMultiplier (edge of radius).
 * For invalid radius, returns minMultiplier.
 */
export function splashFalloff(distance, radius, minMultiplier = 0.2) {
  const safeMin = clamp(minMultiplier, 0, 1);
  if (!(radius > 0)) return safeMin;
  const t = clamp01(distance / radius);
  return Math.max(safeMin, 1 - t);
}
