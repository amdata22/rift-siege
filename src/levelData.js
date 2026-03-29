export const LEVELS = [
  {
    id: "entry-deck",
    name: "Level 1 - Entry Deck",
    roomCount: 8,
    // Grid coords × 12 = world center. Width/depth in world units.
    // Adjacent rooms going same direction: combined dim < 24 to leave corridor gap.
    rooms: [
      { x: 0, z: 0,  width: 8,  depth: 8  }, // 0 — Entry airlock
      { x: 0, z: -1, width: 8,  depth: 10 }, // 1 — Decon / security scan
      { x: 0, z: -2, width: 10, depth: 10 }, // 2 — Guard station (turns east)
      { x: 1, z: -2, width: 12, depth: 10 }, // 3 — Crew junction (east, gap 1)
      { x: 1, z: -3, width: 8,  depth: 10 }, // 4 — Supply storage
      { x: 1, z: -4, width: 10, depth: 10 }, // 5 — Engineering bay
      { x: 2, z: -4, width: 8,  depth: 10 }, // 6 — Access corridor (east, gap 3)
      { x: 2, z: -5, width: 16, depth: 12 }, // 7 — Exit terminal (blue locked, gap 2)
    ],
    ambience: "clean",
    enemies: {
      shamblerLab: 8,
      shamblerGuard: 2,
      crawler: 4,
      brute: 0,
    },
    keycards: [{ color: "blue", room: 5 }],
    lockedDoors: [{ color: "blue", room: 7 }],
    subtitle: "Cygnus X has gone dark. Move fast.",
    notes: "Linear intro — airlock through engineering to the exit terminal. First Crawler vent burst.",
  },
  {
    id: "research-wing",
    name: "Level 2 - Research Wing",
    roomCount: 10,
    rooms: [
      { x: 0, z: 0,  width: 8,  depth: 8  }, // 0 — Maintenance airlock
      { x: 1, z: 0,  width: 10, depth: 8  }, // 1 — Service corridor (east, gap 2)
      { x: 2, z: 0,  width: 12, depth: 10 }, // 2 — Chemical storage (east, gap 1)
      { x: 2, z: -1, width: 10, depth: 10 }, // 3 — Lab anteroom (south, gap 1)
      { x: 2, z: -2, width: 14, depth: 10 }, // 4 — Main research lab (south, gap 1)
      { x: 1, z: -2, width: 8,  depth: 10 }, // 5 — Sample storage (west, gap 3)
      { x: 1, z: -3, width: 10, depth: 12 }, // 6 — Specimen vault (south, gap 1)
      { x: 1, z: -4, width: 8,  depth: 10 }, // 7 — Monitoring station (south, gap 1)
      { x: 2, z: -4, width: 12, depth: 10 }, // 8 — Dr. Hale's office — green keycard (east, gap 1)
      { x: 2, z: -5, width: 18, depth: 12 }, // 9 — Containment chamber (green door, gap 1)
    ],
    ambience: "mixed",
    enemies: {
      shamblerLab: 10,
      shamblerGuard: 6,
      crawler: 8,
      brute: 1,
    },
    keycards: [{ color: "green", room: 8 }],
    lockedDoors: [{ color: "green", room: 9 }],
    subtitle: "Infection spreading. Dr. Hale's research must not leave this station.",
    notes: "Wraps west into a specimen corridor, then back east to Hale's office and the containment chamber. First Brute.",
  },
  {
    id: "reactor-corridor",
    name: "Level 3 - Reactor Corridor",
    roomCount: 12,
    rooms: [
      { x: 0, z: 0,  width: 8,  depth: 8  }, // 0 — Blast door entry
      { x: 0, z: -1, width: 8,  depth: 10 }, // 1 — Decon bay
      { x: 0, z: -2, width: 10, depth: 10 }, // 2 — Utility junction
      { x: 1, z: -2, width: 12, depth: 10 }, // 3 — Coolant station (east, gap 1)
      { x: 2, z: -2, width: 10, depth: 10 }, // 4 — Pump room (east, gap 1)
      { x: 2, z: -3, width: 14, depth: 12 }, // 5 — Reactor maintenance hall
      { x: 2, z: -4, width: 12, depth: 10 }, // 6 — Reactor core access — orange keycard
      { x: 1, z: -4, width: 10, depth: 10 }, // 7 — Control room (west, gap 1)
      { x: 0, z: -4, width: 8,  depth: 10 }, // 8 — Emergency corridor (west, orange door, gap 1)
      { x: 0, z: -5, width: 14, depth: 12 }, // 9 — Generator room
      { x: 1, z: -5, width: 10, depth: 10 }, // 10 — Comms hub — red keycard (east, gap 1)
      { x: 1, z: -7, width: 20, depth: 16 }, // 11 — Reactor core chamber (red door, gap 11)
    ],
    ambience: "infested",
    enemies: {
      shamblerLab: 14,
      shamblerGuard: 8,
      crawler: 10,
      brute: 2,
    },
    keycards: [
      { color: "orange", room: 6 },
      { color: "red", room: 10 },
    ],
    lockedDoors: [
      { color: "orange", room: 8 },
      { color: "red", room: 11 },
    ],
    subtitle: "Reactor containment has failed. The station is overrun.",
    notes: "Serpentine through reactor infrastructure. Dual Brute patrol. Reactor core chamber is a large open killing field.",
  },
  {
    id: "portal-chamber",
    name: "Level 4 - Portal Chamber",
    roomCount: 12,
    rooms: [
      { x: 0, z: 0,  width: 8,  depth: 8  }, // 0 — Transition lock
      { x: 1, z: 0,  width: 10, depth: 8  }, // 1 — Breach corridor (east)
      { x: 2, z: 0,  width: 12, depth: 10 }, // 2 — Outer rift observation
      { x: 2, z: -1, width: 10, depth: 10 }, // 3 — Emitter access (south)
      { x: 1, z: -1, width: 10, depth: 10 }, // 4 — Field generator room (west)
      { x: 0, z: -1, width: 12, depth: 10 }, // 5 — Containment hub (west)
      { x: -1, z: -1, width: 8, depth: 10 }, // 6 — Backup systems (west)
      { x: -1, z: -2, width: 10, depth: 12 }, // 7 — Secondary emitter bay
      { x: 0, z: -2, width: 12, depth: 12 }, // 8 — Anchor control room (east)
      { x: 1, z: -2, width: 14, depth: 14 }, // 9 — Inner sanctum (east)
      { x: 1, z: -3, width: 12, depth: 10 }, // 10 — Rift bridge
      { x: 0, z: -4, width: 22, depth: 20 }, // 11 — THE PORTAL CHAMBER (gap ≥ 4)
    ],
    ambience: "rift",
    enemies: {
      shamblerLab: 18,
      shamblerGuard: 10,
      crawler: 12,
      brute: 3,
    },
    keycards: [],
    lockedDoors: [],
    finalAnchors: 3,
    subtitle: "Close the rift. Whatever it takes.",
    notes: "Loops west and down before converging on the portal chamber. Destroy three rift anchors to win.",
  },
];
