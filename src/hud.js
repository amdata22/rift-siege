const KEY_CARD_ORDER = ["blue", "green", "orange", "red"];

export class Hud {
  constructor(container) {
    this.container = container;
    this.healthSegments = [];
    this.keycardNodes = {};
    this.damageArcOpacity = 0;
    this.damageArcAngle = 0;
    this.interactVisible = false;
    this.interactText = "";

    this.#build();
  }

  #build() {
    this.root = document.createElement("div");
    this.root.className = "overlay";
    this.root.innerHTML = `
      <div class="hud-root">
        <div class="level-label" id="levelLabel">LEVEL 1</div>
        <div class="health-wrap">
          <div class="shield-title">Shield</div>
          <div class="shield-segments" id="shieldSegments"></div>
          <div class="health-title">Health</div>
          <div class="health-segments" id="healthSegments"></div>
        </div>
        <div class="motion-tracker">
          <div class="tracker-title">Motion Tracker</div>
          <canvas id="trackerCanvas" width="128" height="128"></canvas>
        </div>
        <div class="ammo-wrap">
          <div class="weapon-icon" id="weaponIcon">M6D MAGNUM</div>
          <div class="ammo-title">Ammo</div>
          <div class="ammo-main" id="ammoMain">12</div>
          <div class="ammo-reserve" id="ammoReserve">36</div>
        </div>
        <div class="keycards-wrap" id="keycardsWrap"></div>
        <div class="shield-break" id="shieldBreak"></div>
        <div class="crosshair" id="crosshair">
          <div class="ch-top"></div>
          <div class="ch-bottom"></div>
          <div class="ch-left"></div>
          <div class="ch-right"></div>
          <div class="ch-dot"></div>
        </div>
        <div class="interact" id="interactPrompt"></div>
        <div class="damage-indicator">
          <div class="damage-arc" id="damageArc"></div>
        </div>
        <div class="vignette" id="vignette"></div>
        <div class="sniper-scope" id="sniperScope">
          <div class="scope-overlay"></div>
          <div class="scope-reticle">
            <div class="scope-h-line"></div>
            <div class="scope-v-line"></div>
            <div class="scope-center-dot"></div>
            <div class="scope-mil-left"></div>
            <div class="scope-mil-right"></div>
            <div class="scope-mil-top"></div>
            <div class="scope-mil-bottom"></div>
          </div>
        </div>
        <div class="journal-toast" id="journalToast" aria-live="polite">
          <div class="journal-toast-inner">
            <div class="journal-toast-title" id="journalToastTitle"></div>
            <div class="journal-toast-body" id="journalToastBody"></div>
            <div class="journal-toast-hint">Click to dismiss · Press J for all logs</div>
          </div>
        </div>
        <div class="journal-badge" id="journalBadge">Logs 0/10</div>
        <div class="journal-log" id="journalLog">
          <div class="journal-log-panel">
            <div class="journal-log-header">
              <span>STATION LOGS</span>
              <span class="journal-log-close-hint">J / Esc close</span>
            </div>
            <div class="journal-log-list" id="journalLogList"></div>
          </div>
        </div>
      </div>
    `;

    this.container.appendChild(this.root);

    this.levelLabel = this.root.querySelector("#levelLabel");
    this.shieldSegmentsRoot = this.root.querySelector("#shieldSegments");
    this.healthSegmentsRoot = this.root.querySelector("#healthSegments");
    this.trackerCanvas = this.root.querySelector("#trackerCanvas");
    this.trackerCtx = this.trackerCanvas.getContext("2d");
    this.weaponIcon = this.root.querySelector("#weaponIcon");
    this.ammoMain = this.root.querySelector("#ammoMain");
    this.ammoReserve = this.root.querySelector("#ammoReserve");
    this.keycardsWrap = this.root.querySelector("#keycardsWrap");
    this.shieldBreakEl = this.root.querySelector("#shieldBreak");
    this.crosshair = this.root.querySelector("#crosshair");
    this.interactPrompt = this.root.querySelector("#interactPrompt");
    this.damageArc = this.root.querySelector("#damageArc");
    this.vignette = this.root.querySelector("#vignette");
    this.sniperScope = this.root.querySelector("#sniperScope");
    this.journalToast = this.root.querySelector("#journalToast");
    this.journalToastTitle = this.root.querySelector("#journalToastTitle");
    this.journalToastBody = this.root.querySelector("#journalToastBody");
    this.journalBadge = this.root.querySelector("#journalBadge");
    this.journalLog = this.root.querySelector("#journalLog");
    this.journalLogList = this.root.querySelector("#journalLogList");
    this.journalLogOpen = false;
    this.journalToastTimer = null;

    this.shieldSegments = [];
    for (let i = 0; i < 5; i += 1) {
      const seg = document.createElement("div");
      seg.className = "shield-segment";
      this.shieldSegments.push(seg);
      this.shieldSegmentsRoot.appendChild(seg);
    }

    for (let i = 0; i < 10; i += 1) {
      const seg = document.createElement("div");
      seg.className = "health-segment";
      this.healthSegments.push(seg);
      this.healthSegmentsRoot.appendChild(seg);
    }

    for (const key of KEY_CARD_ORDER) {
      const badge = document.createElement("div");
      badge.className = "keycard-badge";
      badge.style.background = key;
      this.keycardNodes[key] = badge;
      this.keycardsWrap.appendChild(badge);
    }
  }

  setLevelLabel(label) {
    this.levelLabel.textContent = label;
  }

  updateHealth(health) {
    const clamped = Math.max(0, Math.min(100, health));
    const lit = Math.ceil((clamped / 100) * 10);
    const color = clamped > 60 ? "var(--hud-green)" : clamped > 30 ? "var(--hud-orange)" : "var(--hud-red)";

    for (let i = 0; i < this.healthSegments.length; i += 1) {
      this.healthSegments[i].style.background = i < lit ? color : "rgba(20,24,30,0.85)";
    }

    this.vignette.style.opacity = clamped < 20 ? `${0.22 + Math.sin(performance.now() * 0.005) * 0.06}` : "0";
  }

  updateShield(shield, maxShield) {
    const ratio = maxShield > 0 ? Math.max(0, Math.min(1, shield / maxShield)) : 0;
    const lit = Math.ceil(ratio * this.shieldSegments.length);
    const recharging = shield < maxShield;
    const color = recharging ? "var(--hud-shield-dim)" : "var(--hud-shield)";

    for (let i = 0; i < this.shieldSegments.length; i += 1) {
      this.shieldSegments[i].style.background = i < lit ? color : "rgba(20,24,30,0.85)";
      this.shieldSegments[i].classList.toggle("shield-recharging", recharging && i < lit);
    }
  }

  showShieldBreak() {
    this.shieldBreakEl.classList.remove("active");
    // Force reflow
    void this.shieldBreakEl.offsetWidth;
    this.shieldBreakEl.classList.add("active");
  }

  updateAmmo(weaponName, mag, reserve, low) {
    this.weaponIcon.textContent = weaponName.toUpperCase();
    this.ammoMain.textContent = `${Math.max(0, Math.floor(mag))}`;
    this.ammoReserve.textContent = `${Math.max(0, Math.floor(reserve))}`;
    this.ammoMain.classList.toggle("ammo-low", !!low);
  }

  updateCrosshair(visible, movementFactor = 0, weaponId = "ar") {
    this.crosshair.style.opacity = visible ? "1" : "0";
    // Gap expands with movement spread
    const baseGap = weaponId === "shotgun" ? 10 : weaponId === "m6d" ? 5 : 4;
    const gap = baseGap + movementFactor * 6;
    this.crosshair.style.setProperty("--ch-gap", `${gap}px`);
    // Sniper/ADS: show only dot, no lines
    const dotsOnly = weaponId === "sniper";
    this.crosshair.classList.toggle("ch-sniper", dotsOnly);
  }

  setSniperScope(active) {
    if (!this.sniperScope) return;
    this.sniperScope.classList.toggle("active", active);
  }

  updateKeycards(collectedSet) {
    for (const key of KEY_CARD_ORDER) {
      const has = collectedSet.has(key);
      this.keycardNodes[key].style.display = has ? "block" : "none";
    }
  }

  drawTracker(blips, hidden = false) {
    const ctx = this.trackerCtx;
    const w = this.trackerCanvas.width;
    const h = this.trackerCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (hidden) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, w, h);
      return;
    }

    const cx = w / 2;
    const cy = h / 2;
    const radius = w * 0.45;
    const sweep = (performance.now() * 0.0022) % (Math.PI * 2);

    ctx.strokeStyle = "rgba(120,170,230,0.65)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(40, 255, 100, 0.45)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweep) * radius, cy + Math.sin(sweep) * radius);
    ctx.stroke();

    for (const blip of blips) {
      const px = cx + blip.x * radius;
      const py = cy + blip.y * radius;
      const r = blip.size ?? 3;
      ctx.fillStyle = blip.color ?? "rgba(120,255,150,0.95)";
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      // Glow ring for brutes
      if (r > 4) {
        ctx.strokeStyle = blip.color ?? "rgba(255,68,68,0.5)";
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(px, py, r + 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }
    }
  }

  showInteract(text) {
    this.interactVisible = true;
    this.interactText = text;
    this.interactPrompt.textContent = text;
    this.interactPrompt.classList.add("visible");
  }

  hideInteract() {
    if (!this.interactVisible) {
      return;
    }
    this.interactVisible = false;
    this.interactPrompt.classList.remove("visible");
  }

  showDamage(directionRadians) {
    this.damageArcOpacity = 1;
    this.damageArcAngle = directionRadians;
    this.damageArc.style.transform = `rotate(${directionRadians}rad)`;
    this.damageArc.style.opacity = "1";
  }

  setJournalProgress(found, total) {
    this.journalBadge.textContent = `Logs ${found}/${total}`;
  }

  showJournalPickup(title, body) {
    this.journalToastTitle.textContent = title;
    this.journalToastBody.textContent = body;
    this.journalToast.classList.add("visible");
    if (this.journalToastTimer) clearTimeout(this.journalToastTimer);
    this.journalToastTimer = setTimeout(() => {
      this.dismissJournalPickup();
    }, 6000);
  }

  dismissJournalPickup() {
    this.journalToast.classList.remove("visible");
    if (this.journalToastTimer) {
      clearTimeout(this.journalToastTimer);
      this.journalToastTimer = null;
    }
  }

  /**
   * @param {Array<{ order: number, title: string, text: string }>} entries sorted by order
   */
  refreshJournalLog(entries) {
    this.journalLogList.innerHTML = "";
    for (const e of entries) {
      const block = document.createElement("div");
      block.className = "journal-log-entry";
      block.innerHTML = `<div class="journal-log-entry-title">${e.title}</div><div class="journal-log-entry-text">${e.text}</div>`;
      this.journalLogList.appendChild(block);
    }
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "journal-log-empty";
      empty.textContent = "No logs recovered yet. Find datapads in the station.";
      this.journalLogList.appendChild(empty);
    }
  }

  toggleJournalLog(open) {
    if (open === undefined) {
      this.journalLogOpen = !this.journalLogOpen;
    } else {
      this.journalLogOpen = open;
    }
    this.journalLog.classList.toggle("open", this.journalLogOpen);
  }

  isJournalLogOpen() {
    return this.journalLogOpen;
  }

  /** Full-screen level transition overlay — fades in, holds, fades out, then calls onDone. */
  showLevelTransition(levelName, subtitle, onDone) {
    const el = document.createElement("div");
    el.style.cssText = `
      position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      background:rgba(4,8,14,0);pointer-events:none;
      transition:background 0.5s ease;
    `;
    el.innerHTML = `
      <div style="opacity:0;transition:opacity 0.5s ease;text-align:center;" id="_transInner">
        <div style="font-size:11px;letter-spacing:0.28em;color:#4a7aa8;text-transform:uppercase;margin-bottom:10px;">Entering</div>
        <div style="font-size:clamp(22px,4vw,38px);font-weight:700;letter-spacing:0.1em;color:#aad4ff;text-transform:uppercase;text-shadow:0 0 28px rgba(80,160,255,0.5);">${levelName}</div>
        <div style="margin-top:12px;font-size:13px;color:#6a9cc0;letter-spacing:0.06em;font-style:italic;">${subtitle || ""}</div>
      </div>
    `;
    this.container.appendChild(el);
    const inner = el.querySelector("#_transInner");

    requestAnimationFrame(() => {
      el.style.background = "rgba(4,8,14,0.88)";
      inner.style.opacity = "1";
    });

    setTimeout(() => {
      inner.style.opacity = "0";
      el.style.background = "rgba(4,8,14,0)";
      setTimeout(() => { el.remove(); onDone?.(); }, 550);
    }, 2200);
  }

  /** Brief "NEW WEAPON" toast at the bottom of the screen. */
  showWeaponToast(weaponName) {
    const el = document.createElement("div");
    el.style.cssText = `
      position:fixed;left:50%;bottom:160px;transform:translateX(-50%) translateY(14px);
      z-index:40;opacity:0;pointer-events:none;
      transition:opacity 280ms ease, transform 280ms ease;
      text-align:center;
    `;
    el.innerHTML = `
      <div style="padding:10px 20px;border:1px solid rgba(255,210,80,0.45);background:linear-gradient(165deg,rgba(16,12,4,0.96),rgba(10,8,2,0.94));">
        <div style="font-size:10px;letter-spacing:0.22em;color:#c8a040;text-transform:uppercase;margin-bottom:4px;">New Weapon</div>
        <div style="font-size:16px;font-weight:700;letter-spacing:0.08em;color:#ffe580;text-shadow:0 0 14px rgba(255,200,50,0.45);">${weaponName}</div>
      </div>
    `;
    this.container.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0)";
    });
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(12px)";
      setTimeout(() => el.remove(), 320);
    }, 2800);
  }

  /** Keycard pickup toast — color-coded to match the card's color. */
  showKeycardToast(color) {
    const colorMap = {
      blue:   { hex: "#4da6ff", glow: "rgba(60,140,255,0.45)", label: "BLUE KEYCARD" },
      green:  { hex: "#44dd88", glow: "rgba(40,200,100,0.45)", label: "GREEN KEYCARD" },
      orange: { hex: "#ff9922", glow: "rgba(255,140,30,0.45)", label: "ORANGE KEYCARD" },
      red:    { hex: "#ff4444", glow: "rgba(255,60,60,0.45)",  label: "RED KEYCARD" },
    };
    const c = colorMap[color] ?? { hex: "#cccccc", glow: "rgba(200,200,200,0.3)", label: "KEYCARD" };
    const el = document.createElement("div");
    el.style.cssText = `
      position:fixed;left:50%;bottom:160px;transform:translateX(-50%) translateY(14px);
      z-index:40;opacity:0;pointer-events:none;
      transition:opacity 260ms ease, transform 260ms ease;text-align:center;
    `;
    el.innerHTML = `
      <div style="padding:9px 20px;border:1px solid ${c.hex}88;background:rgba(6,10,18,0.94);display:flex;align-items:center;gap:10px;">
        <div style="width:10px;height:10px;border-radius:2px;background:${c.hex};box-shadow:0 0 8px ${c.hex};flex-shrink:0;"></div>
        <div>
          <div style="font-size:10px;letter-spacing:0.22em;color:${c.hex}bb;text-transform:uppercase;margin-bottom:2px;">Keycard Acquired</div>
          <div style="font-size:14px;font-weight:700;letter-spacing:0.08em;color:${c.hex};text-shadow:0 0 12px ${c.glow};">${c.label}</div>
        </div>
      </div>
    `;
    this.container.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0)";
    });
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(12px)";
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  /** Brief screen flash for health/shield pickups. */
  showPickupFlash(type = "health") {
    const color = type === "shield" ? "rgba(30,210,255,0.18)" : "rgba(60,220,80,0.16)";
    const el = document.createElement("div");
    el.style.cssText = `
      position:fixed;inset:0;z-index:32;pointer-events:none;
      background:${color};opacity:1;
      transition:opacity 600ms ease;
    `;
    this.container.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "0"; });
    setTimeout(() => el.remove(), 700);
  }

  /** Ramp a red death vignette to given intensity (0–1). */
  setDeathVignette(intensity) {
    if (!this._deathVignette) {
      this._deathVignette = document.createElement("div");
      this._deathVignette.style.cssText = `
        position:fixed;inset:0;z-index:35;pointer-events:none;
        background:radial-gradient(circle at center, transparent 20%, rgba(120,0,0,0.85) 100%);
        opacity:0;transition:opacity 120ms linear;
      `;
      this.container.appendChild(this._deathVignette);
    }
    this._deathVignette.style.opacity = `${Math.max(0, Math.min(1, intensity))}`;
  }

  updateDamage(dt) {
    if (this.damageArcOpacity <= 0) {
      return;
    }
    this.damageArcOpacity = Math.max(0, this.damageArcOpacity - dt / 0.4);
    this.damageArc.style.opacity = `${this.damageArcOpacity}`;
  }

  destroy() {
    this.root?.remove();
  }
}
