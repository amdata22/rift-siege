export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;      // SFX → reverb send + dry
    this.reverbSend = null;  // wet reverb bus
    this.music = null;
    this.lowPass = null;
    this.combatMix = null;
    this.combatTarget = 0;
    this.initialized = false;
    this._riftNodes = [];    // oscillators/sources active during rift ambience
    this._riftGain = null;
  }

  async init() {
    if (this.initialized) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextCtor();

    this.lowPass = this.ctx.createBiquadFilter();
    this.lowPass.type = "lowpass";
    this.lowPass.frequency.value = 20000;

    this.master = this.ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(this.lowPass);
    this.lowPass.connect(this.ctx.destination);

    // Reverb via feedback delay (lightweight, no IR buffer needed)
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.18;
    const delay = this.ctx.createDelay(0.5);
    delay.delayTime.value = 0.085;
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.38;
    const reverbLp = this.ctx.createBiquadFilter();
    reverbLp.type = "lowpass";
    reverbLp.frequency.value = 2800;
    this.reverbSend.connect(delay);
    delay.connect(reverbLp);
    reverbLp.connect(feedback);
    feedback.connect(delay);
    reverbLp.connect(this.master);

    // SFX dry bus
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1.0;
    this.sfxBus.connect(this.master);
    this.sfxBus.connect(this.reverbSend);

    this.music = this.ctx.createGain();
    this.music.gain.value = 0.55;
    this.combatMix = this.ctx.createGain();
    this.combatMix.gain.value = 0;

    this.music.connect(this.master);
    this.combatMix.connect(this.master);

    this.#startMusicLayers();
    this.initialized = true;
  }

  async resume() {
    if (!this.ctx) await this.init();
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  #startMusicLayers() {
    const now = this.ctx.currentTime + 0.05;

    // Sub bass drone
    const baseOsc = this.ctx.createOscillator();
    baseOsc.type = "triangle";
    baseOsc.frequency.value = 55;
    const baseGain = this.ctx.createGain();
    baseGain.gain.value = 0.045;
    baseOsc.connect(baseGain).connect(this.music);
    baseOsc.start(now);

    // Mid pad with slow vibrato
    const padOsc = this.ctx.createOscillator();
    padOsc.type = "sawtooth";
    padOsc.frequency.value = 110;
    const padLfo = this.ctx.createOscillator();
    const padLfoGain = this.ctx.createGain();
    padLfo.frequency.value = 0.18;
    padLfoGain.gain.value = 4;
    padLfo.connect(padLfoGain).connect(padOsc.frequency);
    const padGain = this.ctx.createGain();
    padGain.gain.value = 0.010;
    padOsc.connect(padGain).connect(this.music);
    padOsc.start(now);
    padLfo.start(now);

    // High shimmer (very quiet upper harmonic)
    const shimOsc = this.ctx.createOscillator();
    shimOsc.type = "sine";
    shimOsc.frequency.value = 220;
    const shimLfo = this.ctx.createOscillator();
    const shimLfoGain = this.ctx.createGain();
    shimLfo.frequency.value = 0.07;
    shimLfoGain.gain.value = 0.006;
    shimLfo.connect(shimLfoGain).connect(shimOsc.detune);
    const shimGain = this.ctx.createGain();
    shimGain.gain.value = 0.006;
    shimOsc.connect(shimGain).connect(this.music);
    shimOsc.start(now);
    shimLfo.start(now);

    // Combat pulse (square + LFO on gain)
    const combatOsc = this.ctx.createOscillator();
    combatOsc.type = "square";
    combatOsc.frequency.value = 72;
    const combatGain = this.ctx.createGain();
    combatGain.gain.value = 0.05;
    const combatLfo = this.ctx.createOscillator();
    const combatLfoGain = this.ctx.createGain();
    combatLfo.frequency.value = 5.5;
    combatLfoGain.gain.value = 0.018;
    combatLfo.connect(combatLfoGain).connect(combatGain.gain);
    // Second combat layer: low rumble
    const rumbleOsc = this.ctx.createOscillator();
    rumbleOsc.type = "sawtooth";
    rumbleOsc.frequency.value = 36;
    const rumbleGain = this.ctx.createGain();
    rumbleGain.gain.value = 0.03;
    const rumbleLfo = this.ctx.createOscillator();
    const rumbleLfoGain = this.ctx.createGain();
    rumbleLfo.frequency.value = 3.2;
    rumbleLfoGain.gain.value = 0.012;
    rumbleLfo.connect(rumbleLfoGain).connect(rumbleGain.gain);
    combatOsc.connect(combatGain).connect(this.combatMix);
    rumbleOsc.connect(rumbleGain).connect(this.combatMix);
    combatOsc.start(now);
    combatLfo.start(now);
    rumbleOsc.start(now);
    rumbleLfo.start(now);
  }

  update(dt) {
    if (!this.ctx || !this.combatMix) return;
    const now = this.ctx.currentTime;
    const current = this.combatMix.gain.value;
    const alpha = Math.min(1, dt * (this.combatTarget > current ? 1.0 : 0.25));
    this.combatMix.gain.setValueAtTime(current + (this.combatTarget - current) * alpha, now);
  }

  setCombatActive(active) {
    this.combatTarget = active ? 0.26 : 0.0;
  }

  setLowHealthFilter(active) {
    if (!this.ctx || !this.lowPass) return;
    const now = this.ctx.currentTime;
    this.lowPass.frequency.cancelScheduledValues(now);
    this.lowPass.frequency.linearRampToValueAtTime(active ? 750 : 20000, now + 0.18);
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Single oscillator tone with exponential release. */
  #tone(freq, dur = 0.08, type = "sine", gainAmount = 0.07, destination = null) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(gainAmount, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain).connect(destination || this.sfxBus);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  /** Tone with optional frequency slide (portamento) from freqStart to freq. */
  #toneSlide(freqStart, freqEnd, dur = 0.12, type = "sine", gainAmount = 0.07) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, now + dur * 0.6);
    gain.gain.setValueAtTime(gainAmount, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain).connect(this.sfxBus);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  /** White noise burst through optional low-pass. */
  #noise(dur = 0.08, gainAmount = 0.05, hiCut = 8000, destination = null) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = hiCut;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(gainAmount, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt).connect(gain).connect(destination || this.sfxBus);
    src.start(now);
  }

  /** Noise burst with attack envelope (for thuds). */
  #noisePunch(dur = 0.18, attackT = 0.006, peakGain = 0.12, hiCut = 3000) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(hiCut * 2.5, now);
    filt.frequency.exponentialRampToValueAtTime(hiCut * 0.3, now + dur);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + attackT);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt).connect(gain).connect(this.sfxBus);
    src.start(now);
  }

  // ── Weapon: Assault Rifle ─────────────────────────────────────────────────

  playARFire() {
    // Sharp supersonic crack + body thud + noise
    this.#toneSlide(340, 180, 0.09, "square", 0.11);
    this.#tone(78, 0.18, "triangle", 0.10);
    this.#tone(580, 0.025, "sawtooth", 0.032);
    this.#noisePunch(0.07, 0.003, 0.065, 7000);
    this.#noise(0.04, 0.028, 18000); // high crack tail
  }

  playAREmpty() {
    this.#noise(0.025, 0.038, 5000);
    this.#tone(700, 0.022, "square", 0.022);
  }

  // ── Weapon: M6D Magnum ────────────────────────────────────────────────────

  playM6DFire() {
    // Deep, punchy boom with a sharp high crack
    this.#toneSlide(200, 95, 0.22, "square", 0.16);
    this.#tone(55, 0.28, "triangle", 0.13);
    this.#tone(420, 0.04, "sawtooth", 0.05);
    this.#noisePunch(0.14, 0.004, 0.09, 5500);
    this.#noise(0.05, 0.055, 16000); // crack
  }

  playM6DEmpty() {
    this.#tone(540, 0.035, "square", 0.038);
    this.#noise(0.02, 0.022, 4000);
  }

  // ── Weapon: Shotgun ───────────────────────────────────────────────────────

  playShotgunFire() {
    // Massive low boom, wide noise wash, high-freq crack
    this.#toneSlide(120, 52, 0.32, "square", 0.22);
    this.#tone(38, 0.42, "triangle", 0.16);
    this.#tone(260, 0.1, "sawtooth", 0.06);
    this.#noisePunch(0.28, 0.005, 0.18, 9000);
    this.#noise(0.12, 0.08, 18000); // top crack
    this.#noise(0.35, 0.06, 900);   // sub rumble tail
  }

  playShotgunEmpty() {
    this.#tone(115, 0.09, "triangle", 0.065);
    this.#noise(0.055, 0.045, 2800);
  }

  // ── Weapon: Sniper ────────────────────────────────────────────────────────

  playSniperFire() {
    // Supersonic crack, then long low rumble
    this.#toneSlide(1800, 80, 0.06, "square", 0.22);
    this.#tone(44, 0.48, "triangle", 0.18);
    this.#tone(1400, 0.018, "sawtooth", 0.07);
    this.#noisePunch(0.05, 0.001, 0.16, 16000);
    this.#noise(0.36, 0.07, 1800); // long distant rumble
  }

  playSniperEmpty() {
    this.#tone(820, 0.018, "square", 0.028);
    this.#noise(0.022, 0.022, 5500);
  }

  // ── Weapon: Plasma ────────────────────────────────────────────────────────

  playPlasmaFire() {
    this.#toneSlide(280, 160, 0.08, "sawtooth", 0.055);
    this.#tone(440, 0.05, "sine", 0.025);
  }

  playPlasmaOverheat() {
    this.#toneSlide(900, 420, 0.35, "triangle", 0.08);
    this.#noise(0.2, 0.04, 2000);
  }

  // ── Weapon: Grenade ───────────────────────────────────────────────────────

  playGrenadeLaunch() {
    this.#tone(88, 0.18, "square", 0.13);
    this.#noisePunch(0.12, 0.008, 0.07, 1800);
  }

  playExplosion() {
    // Big boom: sub thud + mid crack + long noise tail
    this.#toneSlide(160, 40, 0.35, "sawtooth", 0.20);
    this.#tone(30, 0.55, "triangle", 0.22);
    this.#noisePunch(0.42, 0.006, 0.22, 6000);
    this.#noise(0.60, 0.10, 800); // distant rumble
    this.#noise(0.08, 0.14, 18000); // sharp crack
  }

  // ── Reload ────────────────────────────────────────────────────────────────

  playReloadPhase(phase, weaponId = "ar") {
    if (weaponId === "plasma") {
      // Plasma: energy hum + rising charge tone
      if (phase === 1) {
        this.#toneSlide(180, 320, 0.12, "sine", 0.038);
        this.#noise(0.06, 0.015, 3000);
      }
      if (phase === 2) {
        this.#toneSlide(280, 480, 0.09, "sine", 0.032);
        this.#tone(440, 0.055, "triangle", 0.022);
      }
      if (phase === 3) {
        this.#toneSlide(520, 900, 0.18, "triangle", 0.042);
        this.#noise(0.04, 0.018, 8000);
      }
      return;
    }
    if (weaponId === "sniper") {
      // Sniper: heavy bolt action — clunk, slide, lock
      if (phase === 1) {
        this.#tone(95, 0.12, "sawtooth", 0.075);
        this.#noisePunch(0.09, 0.005, 0.055, 2800);
      }
      if (phase === 2) {
        this.#toneSlide(140, 80, 0.14, "triangle", 0.068);
        this.#noise(0.06, 0.038, 1800);
      }
      if (phase === 3) {
        this.#tone(72, 0.08, "square", 0.072);
        this.#noisePunch(0.06, 0.003, 0.062, 3500);
        this.#tone(220, 0.04, "triangle", 0.028);
      }
      return;
    }
    // Default (AR, M6D, shotgun)
    if (phase === 1) {
      this.#tone(280, 0.055, "triangle", 0.048);
      this.#noise(0.03, 0.025, 4000);
    }
    if (phase === 2) {
      this.#tone(380, 0.065, "triangle", 0.052);
      this.#noise(0.025, 0.02, 6000);
    }
    if (phase === 3) {
      this.#tone(160, 0.10, "sawtooth", 0.065);
      this.#noise(0.04, 0.03, 2500);
    }
  }

  // ── Melee ─────────────────────────────────────────────────────────────────

  playMelee() {
    this.#toneSlide(200, 95, 0.09, "square", 0.14);
    this.#noisePunch(0.10, 0.004, 0.09, 2200);
    this.#tone(300, 0.04, "sawtooth", 0.055);
  }

  // ── Player feedback ───────────────────────────────────────────────────────

  playFootstep(crouching = false) {
    const freq = crouching ? 95 : 130 + Math.random() * 30;
    const gain = crouching ? 0.022 : 0.038;
    this.#noisePunch(crouching ? 0.05 : 0.07, 0.005, gain, crouching ? 1200 : 1800);
    this.#tone(freq, crouching ? 0.035 : 0.05, "triangle", gain * 0.7);
  }

  playHitConfirm() {
    this.#tone(1050, 0.025, "square", 0.028);
  }

  playShieldHit() {
    this.#toneSlide(1400, 800, 0.10, "triangle", 0.06);
    this.#noise(0.06, 0.035, 12000);
  }

  playShieldRecharge() {
    this.#tone(700, 0.08, "triangle", 0.038);
    this.#tone(1050, 0.12, "triangle", 0.032);
  }

  playImpactSpark() {
    this.#tone(2400, 0.022, "square", 0.016);
    this.#noise(0.03, 0.018, 16000);
  }

  playSprint() {
    this.#tone(148, 0.045, "triangle", 0.024);
  }

  // ── Enemy voices ──────────────────────────────────────────────────────────

  playShamblerMoan() {
    this.#toneSlide(145, 95, 0.5, "sawtooth", 0.048);
    this.#noise(0.3, 0.018, 600);
  }

  /** Alert bark when enemy first spots the player */
  playAlertBark(type) {
    if (!this.ctx) return;
    if (type === "brute") {
      // Deep resonant roar with sub-bass punch
      this.#toneSlide(95, 45, 0.45, "sawtooth", 0.09);
      this.#tone(38, 0.38, "triangle", 0.12);
      this.#noisePunch(0.22, 0.008, 0.07, 1800);
    } else if (type === "crawler") {
      // Sharp shriek — rapid rising pitch
      this.#toneSlide(380, 720, 0.12, "square", 0.055);
      this.#toneSlide(620, 1100, 0.09, "sawtooth", 0.032);
      this.#noise(0.08, 0.022, 4000);
    } else {
      // Shambler guttural alert growl — low groan + rasp
      this.#toneSlide(165, 85, 0.35, "sawtooth", 0.062);
      this.#tone(60, 0.28, "triangle", 0.08);
      this.#noise(0.22, 0.024, 1000);
    }
  }

  playCrawlerChitter() {
    for (let i = 0; i < 3; i += 1) {
      const delay = i * 0.055;
      setTimeout(() => {
        this.#tone(480 + Math.random() * 80, 0.06, "square", 0.028);
      }, delay * 1000);
    }
  }

  /** Play a pain grunt when an enemy takes damage but doesn't die. */
  playEnemyPain(type) {
    if (!this.ctx) return;
    if (type === "brute") {
      this.#toneSlide(180, 80, 0.22, "sawtooth", 0.06);
      this.#noise(0.12, 0.025, 900);
    } else if (type === "crawler") {
      this.#toneSlide(520, 280, 0.12, "square", 0.038);
    } else {
      // shambler / reanimated
      this.#toneSlide(220, 120, 0.18, "sawtooth", 0.042);
      this.#noise(0.08, 0.018, 1200);
    }
  }

  /** Play a death sound when an enemy is killed. */
  playEnemyDeath(type) {
    if (!this.ctx) return;
    if (type === "brute") {
      this.#toneSlide(140, 35, 0.55, "sawtooth", 0.10);
      this.#noisePunch(0.40, 0.012, 0.08, 1400);
    } else if (type === "crawler") {
      this.#toneSlide(380, 160, 0.22, "square", 0.05);
      this.#noise(0.14, 0.03, 2200);
    } else {
      this.#toneSlide(200, 80, 0.32, "sawtooth", 0.06);
      this.#noise(0.18, 0.028, 1600);
    }
  }

  // ── Ambient / environment ─────────────────────────────────────────────────

  playPAStatic() {
    this.#tone(1100, 0.06, "square", 0.022);
    this.#tone(1700, 0.04, "sawtooth", 0.016);
    this.#noise(0.04, 0.012, 8000);
  }

  playPhoneRing() {
    this.#tone(880, 0.08, "triangle", 0.032);
    this.#tone(1320, 0.06, "triangle", 0.026);
  }

  playBroadcastGlitch() {
    this.#noise(0.06, 0.028, 5000);
    this.#tone(260, 0.08, "sawtooth", 0.018);
    this.#tone(580, 0.04, "square", 0.012);
  }

  // ── Rift ambience (Level 4 persistent layer) ─────────────────────────────

  startRiftAmbience() {
    if (!this.ctx) return;
    this.stopRiftAmbience();
    const now = this.ctx.currentTime + 0.05;

    this._riftGain = this.ctx.createGain();
    this._riftGain.gain.setValueAtTime(0, now);
    this._riftGain.gain.linearRampToValueAtTime(1.0, now + 3.5);
    this._riftGain.connect(this.music);

    // Deep sub-bass rift hum (lower and heavier than normal drone)
    const sub = this.ctx.createOscillator();
    sub.type = "sawtooth";
    sub.frequency.value = 28;
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.055;
    sub.connect(subGain).connect(this._riftGain);
    sub.start(now);
    this._riftNodes.push(sub);

    // Mid distortion layer — slowly detuning
    const mid = this.ctx.createOscillator();
    mid.type = "square";
    mid.frequency.value = 56;
    const midLfo = this.ctx.createOscillator();
    const midLfoGain = this.ctx.createGain();
    midLfo.frequency.value = 0.04;
    midLfoGain.gain.value = 9;
    midLfo.connect(midLfoGain).connect(mid.detune);
    const midGain = this.ctx.createGain();
    midGain.gain.value = 0.022;
    mid.connect(midGain).connect(this._riftGain);
    mid.start(now);
    midLfo.start(now);
    this._riftNodes.push(mid, midLfo);

    // High alien shimmer — wavering sine
    const hi = this.ctx.createOscillator();
    hi.type = "sine";
    hi.frequency.value = 440;
    const hiLfo = this.ctx.createOscillator();
    const hiLfoGain = this.ctx.createGain();
    hiLfo.frequency.value = 0.13;
    hiLfoGain.gain.value = 14;
    hiLfo.connect(hiLfoGain).connect(hi.detune);
    const hiGain = this.ctx.createGain();
    hiGain.gain.value = 0.008;
    hi.connect(hiGain).connect(this._riftGain);
    hi.start(now);
    hiLfo.start(now);
    this._riftNodes.push(hi, hiLfo);

    // Arrhythmic dimensional "crackle" — slow LFO-gated noise
    const crackleGain = this.ctx.createGain();
    crackleGain.gain.value = 0.0;
    const crackleLfo = this.ctx.createOscillator();
    crackleLfo.type = "sine";
    crackleLfo.frequency.value = 0.22;
    const crackleLfoGain = this.ctx.createGain();
    crackleLfoGain.gain.value = 0.018;
    crackleLfo.connect(crackleLfoGain).connect(crackleGain.gain);
    crackleLfo.start(now);
    this._riftNodes.push(crackleLfo);

    // Filtered noise bed for that "tear in space" feel
    const bufLen = Math.ceil(this.ctx.sampleRate * 2.0);
    const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = this.ctx.createBufferSource();
    noiseSrc.buffer = buf;
    noiseSrc.loop = true;
    const noiseFilt = this.ctx.createBiquadFilter();
    noiseFilt.type = "bandpass";
    noiseFilt.frequency.value = 320;
    noiseFilt.Q.value = 0.6;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.014;
    noiseSrc.connect(noiseFilt).connect(noiseGain).connect(this._riftGain);
    noiseSrc.start(now);
    this._riftNodes.push(noiseSrc);
  }

  stopRiftAmbience() {
    if (this._riftGain) {
      const now = this.ctx?.currentTime ?? 0;
      this._riftGain.gain.setValueAtTime(this._riftGain.gain.value, now);
      this._riftGain.gain.linearRampToValueAtTime(0, now + 1.2);
    }
    for (const node of this._riftNodes) {
      try { node.stop?.(); } catch (_) { /* already stopped */ }
      try { node.disconnect?.(); } catch (_) { /* already disconnected */ }
    }
    this._riftNodes = [];
    this._riftGain = null;
  }

  /** Stinger played at level transition — low boom + rising tone. */
  playLevelTransition() {
    this.#toneSlide(60, 110, 0.6, "triangle", 0.09);
    this.#toneSlide(120, 220, 0.4, "sine", 0.06);
    this.#noise(0.25, 0.04, 1200);
  }
}
