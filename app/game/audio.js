"use client";

/*
  Audio engine, rebuilt.

  Everything below follows three rules learned the hard way on this project:

  1. NO CONVOLUTION. Tone's Reverb is a ConvolverNode, which the Tone
     performance guide names as the single most processor-intensive node
     available. It also has to render its impulse response through an offline
     context before it makes any sound, which was most of the load time.

  2. NO NOISE SOURCES. Every NoiseSynth is gone, percussion included. A noise
     generator through a low-pass is indistinguishable from a buzz on a small
     speaker, and it was firing on the clave of every bar.

  3. NO DYNAMICS. No compressor, no limiter. Both modulate gain on a shared bus,
     which ducks music against effects and, in the limiter's case, modulates at
     roughly 100 Hz. The chain runs around -25 dBFS, so there is nothing to
     protect against.

  Two further rules about scheduling:

  4. Everything is scheduled 50 ms ahead, per Tone's own guidance that values
     under 0.1 s are imperceptible but meaningfully reduce pops.

  5. Nothing monophonic is ever retriggered while it is still sounding. Pitch
     sweeps build a throwaway oscillator each time instead of sharing one voice,
     because overlapping ramps on a single oscillator glitch badly.

  Nothing is sampled, so there are no files to fetch and nothing to 404.
*/

// C major pentatonic. Every catch walks one step up, so a clean run plays a
// rising phrase; a miss resets it to the bottom.
const SCALE = [
  "C4", "D4", "E4", "G4", "A4",
  "C5", "D5", "E5", "G5", "A5",
  "C6",
];
const WRAP_TO = 4;

const PROGRESSIONS = {
  base: {
    chords: [
      ["C4", "E4", "G4", "B4"],
      ["A3", "C4", "E4", "G4"],
      ["D4", "F4", "A4", "C5"],
      ["G3", "B3", "D4", "F4"],
    ],
    roots: ["C2", "A1", "D2", "G1"],
  },
  bright: {
    chords: [
      ["D4", "F#4", "A4", "C#5"],
      ["B3", "D4", "F#4", "A4"],
      ["E4", "G4", "B4", "D5"],
      ["A3", "C#4", "E4", "G4"],
    ],
    roots: ["D2", "B1", "E2", "A1"],
  },
  dream: {
    chords: [
      ["F3", "A3", "C4", "E4"],
      ["D3", "F3", "A3", "C4"],
      ["G3", "B3", "D4", "F4"],
      ["C4", "E4", "G4", "B4"],
    ],
    roots: ["F2", "D2", "G1", "C2"],
  },
  minor: {
    chords: [
      ["A3", "C4", "E4", "G4"],
      ["D3", "F3", "A3", "C4"],
      ["F3", "A3", "C4", "E4"],
      ["E3", "G#3", "B3", "D4"],
    ],
    roots: ["A1", "D2", "F2", "E2"],
  },
};

// One level for every bed: the music never changes loudness between menus,
// play and power-ups. Only tempo, filter and harmony move.
const MODES = {
  base: { bpm: 128, filter: 2200, prog: "base", drone: false, vol: -10 },
  mango: { bpm: 142, filter: 3200, prog: "bright", drone: false, vol: -10 },
  shield: { bpm: 122, filter: 2000, prog: "base", drone: true, vol: -10 },
  bowl: { bpm: 100, filter: 2400, prog: "dream", drone: false, vol: -10 },
  menu: { bpm: 74, filter: 2000, prog: "minor", drone: false, vol: -10 },
};

const MOTIFS = {
  mango: ["C5", "E5", "G5", "C6"],
  shield: ["E4", "B4", "E5", "G#5"],
  bowl: ["A4", "C5", "E5", "A5"],
  health: ["G4", "B4", "D5", "G5"],
  fork: ["D5", "G5", "B5", "D6"],
};

// Bossa comping. Bar one syncopates on the and-of-two, bar two pushes earlier.
// The bass keeps a two-feel: root on one, fifth on three. No percussion.
const COMP_A = [0, 3, 6];
const COMP_B = [0, 2, 5];
const BASS_HITS = [0, 4];

// Tone is a large module. Prefetching it on mount keeps the wait off the
// Start button without creating an AudioContext before the player has acted.
let tonePromise = null;
export function preloadAudio() {
  if (!tonePromise) tonePromise = import("tone");
  return tonePromise;
}

export async function createAudio() {
  const Tone = await preloadAudio();

  // The largest buffer the browser will give us. A small buffer underruns
  // under canvas load, and an underrun is heard as a pop.
  const context = new Tone.Context({ latencyHint: "playback", lookAhead: 0.1 });
  Tone.setContext(context);
  await Tone.start();

  const transport = Tone.getTransport();
  transport.bpm.value = MODES.base.bpm;

  /* ------------------------------------------------------------ routing */

  const master = new Tone.Volume(-3).toDestination();

  const sfxBus = new Tone.Volume(-4);
  const sfxFilter = new Tone.Filter(3600, "lowpass");
  sfxBus.connect(sfxFilter);
  sfxFilter.connect(master);

  const musicBus = new Tone.Volume(MODES.base.vol);
  const musicFilter = new Tone.Filter(MODES.base.filter, "lowpass");
  musicBus.connect(musicFilter);
  musicFilter.connect(master);

  /* ------------------------------------------------------------- voices */

  const pluck = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.28, sustain: 0, release: 0.35 },
  }).connect(sfxBus);
  pluck.maxPolyphony = 16;
  pluck.volume.value = -6;

  const soft = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.03, decay: 0.3, sustain: 0, release: 0.4 },
  }).connect(sfxBus);
  soft.maxPolyphony = 16;
  soft.volume.value = -4;

  // Replaces the old brown-noise thud. A low sine gives the same weight under
  // a hit without putting a noise generator anywhere near the output.
  const body = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.008, decay: 0.22, sustain: 0, release: 0.2 },
  }).connect(sfxBus);
  body.maxPolyphony = 6;
  body.volume.value = -8;

  const comp = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.012, decay: 0.9, sustain: 0.04, release: 0.7 },
  }).connect(musicBus);
  comp.maxPolyphony = 12;
  comp.volume.value = -9;

  const bass = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.02, decay: 0.5, sustain: 0.2, release: 0.5 },
  }).connect(musicBus);
  bass.volume.value = -6;

  const drone = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 1.6, decay: 0.4, sustain: 0.6, release: 2.6 },
  }).connect(musicBus);
  drone.maxPolyphony = 4;
  drone.volume.value = -20;

  /* --------------------------------------------------------- scheduling */

  const LEAD = 0.05; // Tone's own guidance for avoiding performance pops
  let lastAt = 0;
  const at = (offset) => {
    const now = Tone.now() + LEAD + (offset || 0);
    lastAt = Math.max(now, lastAt + 0.012);
    return lastAt;
  };

  let step = 0;
  let disposed = false;
  let modeStack = [];
  let droneOn = false;
  let menuTimer = null;
  let prog = PROGRESSIONS.base;

  // A throwaway oscillator per sweep. Sharing one voice meant a second sweep
  // could start while the first was still ramping, and overlapping frequency
  // ramps on one oscillator sound broken.
  const glide = (from, to, dur, peak) => {
    if (disposed) return;
    const t = at();
    const amp = new Tone.Gain(0).connect(sfxBus);
    const osc = new Tone.Oscillator({ frequency: from, type: "sine" }).connect(amp);
    osc.start(t);
    osc.frequency.exponentialRampTo(to, dur, t);
    // ramped in and out of silence, so there is no step at either end
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + 0.02);
    amp.gain.linearRampToValueAtTime(0, t + dur);
    osc.stop(t + dur + 0.05);
    setTimeout(() => {
      try {
        osc.dispose();
        amp.dispose();
      } catch {}
    }, (dur + 0.6) * 1000);
  };

  const applyMode = () => {
    const key = modeStack.length ? modeStack[modeStack.length - 1] : "base";
    const cfg = MODES[key] || MODES.base;
    transport.bpm.rampTo(cfg.bpm, 1.1);
    musicFilter.frequency.rampTo(cfg.filter, 0.7);
    musicBus.volume.rampTo(cfg.vol, 0.9);
    prog = PROGRESSIONS[cfg.prog];

    if (cfg.drone && !droneOn) {
      droneOn = true;
      drone.triggerAttack(["C3", "G3"], at());
    } else if (!cfg.drone && droneOn) {
      droneOn = false;
      drone.releaseAll(at());
    }
  };

  /* ---------------------------------------------------------- the bed */

  const EVENTS = [];
  for (let bar = 0; bar < 4; bar++) {
    for (let e = 0; e < 8; e++) EVENTS.push({ bar, e });
  }

  const seq = new Tone.Sequence(
    (time, v) => {
      // No draw calls or DOM work in here: this runs on a worker clock, well
      // ahead of when the sound is heard.
      const chord = prog.chords[v.bar];
      const root = prog.roots[v.bar];
      const odd = v.bar % 2 === 1;
      if ((odd ? COMP_B : COMP_A).includes(v.e)) {
        comp.triggerAttackRelease(chord, "8n", time, 0.16);
      }
      if (BASS_HITS.includes(v.e)) {
        bass.triggerAttackRelease(root, v.e === 0 ? "4n" : "8n", time, 0.3);
      }
    },
    EVENTS,
    "8n"
  );
  seq.start(0);

  /* ---------------------------------------------------------------- api */

  const api = {
    catchFruit() {
      if (disposed) return;
      const note = SCALE[Math.min(step, SCALE.length - 1)];
      pluck.triggerAttackRelease(note, "16n", at(), 0.5);
      step = step + 1 >= SCALE.length ? WRAP_TO : step + 1;
    },

    resetPhrase() {
      step = 0;
    },

    powerUp(key) {
      if (disposed) return;
      const motif = MOTIFS[key] || MOTIFS.mango;
      motif.forEach((n, i) =>
        pluck.triggerAttackRelease(n, "16n", at(i * 0.075), 0.45)
      );
      if (MODES[key]) {
        modeStack = modeStack.filter((k) => k !== key).concat(key);
        applyMode();
      }
    },

    powerDown(key) {
      if (disposed) return;
      modeStack = modeStack.filter((k) => k !== key);
      applyMode();
      soft.triggerAttackRelease("G3", "16n", at(), 0.2);
    },

    heal() {
      if (disposed) return;
      MOTIFS.health.forEach((n, i) =>
        soft.triggerAttackRelease(n, "8n", at(i * 0.09), 0.4)
      );
    },

    fullHealth() {
      if (disposed) return;
      ["D5", "A5"].forEach((n, i) =>
        pluck.triggerAttackRelease(n, "16n", at(i * 0.08), 0.45)
      );
      soft.triggerAttackRelease("F#5", "8n", at(0.16), 0.35);
    },

    bonus() {
      if (disposed) return;
      glide("C5", "C7", 0.26, 0.09);
      ["G5", "A5", "C6", "E6"].forEach((n, i) =>
        pluck.triggerAttackRelease(n, "32n", at(i * 0.05), 0.4)
      );
    },

    forkShot() {
      if (disposed) return;
      glide("E5", "B6", 0.12, 0.07);
      pluck.triggerAttackRelease("B5", "32n", at(0.03), 0.35);
    },

    forkGained() {
      if (disposed) return;
      MOTIFS.fork.forEach((n, i) =>
        pluck.triggerAttackRelease(n, "16n", at(i * 0.07), 0.45)
      );
    },

    block() {
      if (disposed) return;
      soft.triggerAttackRelease("D4", "16n", at(), 0.3);
    },

    // Above 300 Hz, where a phone speaker can actually reproduce it.
    miss() {
      if (disposed) return;
      step = 0;
      soft.triggerAttackRelease("Eb4", "16n", at(), 0.5);
      soft.triggerAttackRelease("D4", "8n", at(0.085), 0.45);
      body.triggerAttackRelease("D3", "16n", at(0.01), 0.4);
    },

    pepper() {
      if (disposed) return;
      step = 0;
      body.triggerAttackRelease("F3", "8n", at(), 0.5);
      soft.triggerAttackRelease("F4", "8n", at(0.02), 0.5);
      soft.triggerAttackRelease("Gb4", "8n", at(0.03), 0.42);
    },

    scorpion() {
      if (disposed) return;
      step = 0;
      body.triggerAttackRelease("D3", "4n", at(), 0.55);
      glide("A5", "A2", 0.5, 0.1);
    },

    sweep() {
      if (disposed) return;
      ["C5", "E5", "G5", "A5", "C6"].forEach((n, i) =>
        soft.triggerAttackRelease(n, "32n", at(i * 0.045), 0.24)
      );
    },

    gameOver() {
      if (disposed) return;
      step = 0;
      modeStack = [];
      applyMode();
      musicBus.volume.rampTo(-30, 0.5);
      ["C5", "A4", "F4", "E4"].forEach((n, i) =>
        soft.triggerAttackRelease(n, "8n", at(0.1 + i * 0.16), 0.5)
      );
      menuTimer = setTimeout(() => {
        if (!disposed) api.menuMusic();
      }, 1200);
    },

    menuMusic() {
      if (disposed) return;
      modeStack = ["menu"];
      applyMode();
      if (transport.state !== "started") transport.start("+0.1");
    },

    startMusic() {
      if (disposed) return;
      clearTimeout(menuTimer);
      modeStack = [];
      applyMode();
      if (transport.state !== "started") transport.start("+0.1");
    },

    async setFocused(focused) {
      if (disposed) return;
      const raw = Tone.getContext().rawContext;
      try {
        if (!focused) {
          transport.pause();
          if (raw.state === "running") await raw.suspend();
        } else {
          if (raw.state === "suspended") await raw.resume();
          if (transport.state === "paused") transport.start();
        }
      } catch {}
    },

    async resume() {
      if (disposed) return;
      try {
        const raw = Tone.getContext().rawContext;
        if (raw.state === "suspended") await raw.resume();
      } catch {}
    },

    setMuted(muted) {
      if (disposed) return;
      master.mute = !!muted;
    },

    dispose() {
      disposed = true;
      clearTimeout(menuTimer);
      try {
        transport.stop();
        transport.cancel();
        seq.dispose();
        [pluck, soft, body, comp, bass, drone, musicBus, musicFilter, sfxBus,
         sfxFilter, master].forEach((n) => n.dispose());
      } catch {}
    },
  };

  return api;
}
