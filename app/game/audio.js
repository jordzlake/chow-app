"use client";

/*
  Audio engine, written directly against Web Audio.

  This used to be Tone.js. Everything it was doing for us amounted to
  oscillators with gain envelopes, two biquad filters and a step sequencer,
  which is what is below. Tone was shipping 78 KB gzipped (333 KB raw) as a
  separate chunk for that, and it had to be downloaded before a single sound
  could play, which was the load time. Its context wrapper was also the reason
  the first gesture kept failing: setContext has to happen after the module
  resolves, and an await can land outside the gesture that granted permission.

  With no module to fetch, the AudioContext is created synchronously inside the
  click and sound is available on the very first press.

  Design rules carried over, all of which were learned the hard way here:
    - No convolution reverb. It was the most expensive node in the graph and
      had to render an impulse response before making any sound.
    - No noise sources anywhere, percussion included. A noise generator through
      a filter is indistinguishable from a buzz on a small speaker.
    - No compressor and no limiter. Both modulate gain on a bus shared by music
      and effects. The chain peaks far below clipping, so neither is needed.
    - Every note is its own oscillator, ramped up from silence and down to it.
      Nothing is ever retriggered while still sounding, so nothing clicks.
    - Notes stay above ~300 Hz, since phone speakers cannot reproduce below it.
*/

/* ------------------------------------------------------------------ notes */

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// "F#4" / "Eb3" / "C5" -> Hz
function hz(note) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(note);
  if (!m) return 440;
  let semi = SEMITONES[m[1]];
  if (m[2] === "#") semi += 1;
  if (m[2] === "b") semi -= 1;
  const midi = semi + (Number(m[3]) + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const db = (value) => Math.pow(10, value / 20);

/* ----------------------------------------------------------------- music */

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
    roots: ["C2", "A2", "D2", "G2"],
  },
  bright: {
    chords: [
      ["D4", "F#4", "A4", "C#5"],
      ["B3", "D4", "F#4", "A4"],
      ["E4", "G4", "B4", "D5"],
      ["A3", "C#4", "E4", "G4"],
    ],
    roots: ["D2", "B2", "E2", "A2"],
  },
  dream: {
    chords: [
      ["F3", "A3", "C4", "E4"],
      ["D3", "F3", "A3", "C4"],
      ["G3", "B3", "D4", "F4"],
      ["C4", "E4", "G4", "B4"],
    ],
    roots: ["F2", "D2", "G2", "C2"],
  },
  minor: {
    chords: [
      ["A3", "C4", "E4", "G4"],
      ["D3", "F3", "A3", "C4"],
      ["F3", "A3", "C4", "E4"],
      ["E3", "G#3", "B3", "D4"],
    ],
    roots: ["A2", "D2", "F2", "E2"],
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

// Bossa comping: bar one syncopates on the and-of-two, bar two pushes earlier.
// Bass keeps a two-feel, root on one and fifth on three. No percussion.
const COMP_A = [0, 3, 6];
const COMP_B = [0, 2, 5];
const BASS_HITS = [0, 4];

const STEPS = 32; // four bars of eighths
const LEAD = 0.03; // keeps events off the edge of the current render quantum
const SCHEDULE_AHEAD = 0.15;
const TICK_MS = 25;

// Nothing to download any more. Kept so callers need not change.
export function preloadAudio() {
  return Promise.resolve();
}

/*
  `rawContext` should be an AudioContext the page created synchronously inside
  a click or touch handler. One is created here if it is missing, but passing
  it in is what guarantees the gesture is honoured.
*/
export async function createAudio(rawContext) {
  const Ctx = typeof window !== "undefined"
    ? window.AudioContext || window.webkitAudioContext
    : null;
  if (!Ctx) return null;

  const ctx = rawContext || new Ctx({ latencyHint: "interactive" });
  try {
    if (ctx.state === "suspended") await ctx.resume();
  } catch {}

  /* --------------------------------------------------------- routing */

  const master = ctx.createGain();
  master.gain.value = db(-3);
  master.connect(ctx.destination);

  const sfxFilter = ctx.createBiquadFilter();
  sfxFilter.type = "lowpass";
  sfxFilter.frequency.value = 3600;
  sfxFilter.connect(master);

  const sfxBus = ctx.createGain();
  sfxBus.gain.value = db(-4);
  sfxBus.connect(sfxFilter);

  const musicFilter = ctx.createBiquadFilter();
  musicFilter.type = "lowpass";
  musicFilter.frequency.value = MODES.base.filter;
  musicFilter.connect(master);

  const musicBus = ctx.createGain();
  musicBus.gain.value = db(MODES.base.vol);
  musicBus.connect(musicFilter);

  /* ---------------------------------------------------------- voices */

  let disposed = false;
  let muted = false;

  /*
    One oscillator per note, disposed when it ends. This is the thing that
    removed the clicks: a fresh voice can never be cut off mid-cycle by a
    retrigger, and the gain always starts at zero and ends at zero, so there is
    no step change anywhere for the speaker to snap on.
  */
  const note = (bus, freq, t, hold, peak, type, attack, tail) => {
    if (disposed) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || "triangle";
    osc.frequency.setValueAtTime(freq, t);
    osc.connect(gain);
    gain.connect(bus);

    const a = attack == null ? 0.006 : attack;
    const decayTo = t + hold + (tail == null ? 0.25 : tail);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, decayTo);

    osc.start(t);
    osc.stop(decayTo + 0.02);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {}
    };
  };

  // A pitch sweep, also on its own throwaway oscillator so two can overlap.
  const glide = (fromNote, toNote, dur, peak) => {
    if (disposed) return;
    const t = at();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(hz(fromNote), t);
    osc.frequency.exponentialRampToValueAtTime(hz(toNote), t + dur);
    osc.connect(gain);
    gain.connect(sfxBus);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {}
    };
  };

  // sustained pair for the shield bed
  let droneNodes = null;
  const droneOn = (on) => {
    const t = ctx.currentTime;
    if (on && !droneNodes) {
      droneNodes = ["C3", "G3"].map((n) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = hz(n);
        osc.connect(gain);
        gain.connect(musicBus);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(db(-20), t + 1.6);
        osc.start(t);
        return { osc, gain };
      });
    } else if (!on && droneNodes) {
      const dying = droneNodes;
      droneNodes = null;
      for (const d of dying) {
        d.gain.gain.cancelScheduledValues(t);
        d.gain.gain.setValueAtTime(Math.max(d.gain.gain.value, 0.0002), t);
        d.gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
        d.osc.stop(t + 1.3);
        d.osc.onended = () => {
          try {
            d.osc.disconnect();
            d.gain.disconnect();
          } catch {}
        };
      }
    }
  };

  /* ------------------------------------------------------- scheduling */

  let lastAt = 0;
  const at = (offset) => {
    const now = ctx.currentTime + LEAD + (offset || 0);
    lastAt = Math.max(now, lastAt + 0.012);
    return lastAt;
  };

  let step = 0; // position in the pentatonic phrase
  let modeStack = [];
  let menuTimer = null;
  let prog = PROGRESSIONS.base;

  /*
    Lookahead sequencer. A timer wakes every 25 ms and schedules whatever falls
    inside the next 150 ms, so the audio clock stays exact even when the main
    thread stalls behind a frame of canvas work.
  */
  let seqTimer = null;
  let seqStep = 0;
  let nextStepTime = 0;
  let bpm = MODES.base.bpm;
  let targetBpm = MODES.base.bpm;

  const scheduleStep = (index, time) => {
    const bar = Math.floor(index / 8) % 4;
    const e = index % 8;
    const odd = bar % 2 === 1;

    if ((odd ? COMP_B : COMP_A).includes(e)) {
      for (const n of prog.chords[bar]) {
        note(musicBus, hz(n), time, 0.18, db(-9) * 0.5, "triangle", 0.012, 0.7);
      }
    }
    if (BASS_HITS.includes(e)) {
      note(musicBus, hz(prog.roots[bar]), time, e === 0 ? 0.32 : 0.18,
           db(-6) * 0.55, "sine", 0.02, 0.35);
    }
  };

  const tick = () => {
    if (disposed) return;
    // ease toward the mode's tempo instead of jumping
    bpm += (targetBpm - bpm) * 0.08;
    const eighth = 60 / bpm / 2;
    while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
      scheduleStep(seqStep, Math.max(nextStepTime, ctx.currentTime + 0.01));
      seqStep = (seqStep + 1) % STEPS;
      nextStepTime += eighth;
    }
  };

  const startSeq = () => {
    if (seqTimer) return;
    nextStepTime = ctx.currentTime + 0.1;
    seqTimer = setInterval(tick, TICK_MS);
  };
  const stopSeq = () => {
    if (!seqTimer) return;
    clearInterval(seqTimer);
    seqTimer = null;
  };

  const applyMode = () => {
    const key = modeStack.length ? modeStack[modeStack.length - 1] : "base";
    const cfg = MODES[key] || MODES.base;
    const t = ctx.currentTime;
    targetBpm = cfg.bpm;
    musicFilter.frequency.setTargetAtTime(cfg.filter, t, 0.3);
    musicBus.gain.setTargetAtTime(db(cfg.vol), t, 0.3);
    prog = PROGRESSIONS[cfg.prog];
    droneOn(!!cfg.drone);
  };

  /* -------------------------------------------------------------- api */

  const api = {
    catchFruit() {
      const n = SCALE[Math.min(step, SCALE.length - 1)];
      note(sfxBus, hz(n), at(), 0.12, 0.5, "triangle", 0.005, 0.3);
      step = step + 1 >= SCALE.length ? WRAP_TO : step + 1;
    },

    resetPhrase() {
      step = 0;
    },

    powerUp(key) {
      const motif = MOTIFS[key] || MOTIFS.mango;
      motif.forEach((n, i) =>
        note(sfxBus, hz(n), at(i * 0.075), 0.12, 0.45, "triangle", 0.005, 0.3)
      );
      if (MODES[key]) {
        modeStack = modeStack.filter((k) => k !== key).concat(key);
        applyMode();
      }
    },

    powerDown(key) {
      modeStack = modeStack.filter((k) => k !== key);
      applyMode();
      note(sfxBus, hz("G3"), at(), 0.1, 0.2, "sine", 0.02, 0.25);
    },

    heal() {
      MOTIFS.health.forEach((n, i) =>
        note(sfxBus, hz(n), at(i * 0.09), 0.18, 0.4, "sine", 0.02, 0.35)
      );
    },

    fullHealth() {
      ["D5", "A5"].forEach((n, i) =>
        note(sfxBus, hz(n), at(i * 0.08), 0.12, 0.45, "triangle", 0.005, 0.3)
      );
      note(sfxBus, hz("F#5"), at(0.16), 0.16, 0.35, "sine", 0.02, 0.3);
    },

    bonus() {
      glide("C5", "C7", 0.26, 0.09);
      ["G5", "A5", "C6", "E6"].forEach((n, i) =>
        note(sfxBus, hz(n), at(i * 0.05), 0.08, 0.4, "triangle", 0.004, 0.22)
      );
    },

    forkShot() {
      glide("E5", "B6", 0.12, 0.07);
      note(sfxBus, hz("B5"), at(0.03), 0.07, 0.35, "triangle", 0.004, 0.2);
    },

    forkGained() {
      MOTIFS.fork.forEach((n, i) =>
        note(sfxBus, hz(n), at(i * 0.07), 0.12, 0.45, "triangle", 0.005, 0.3)
      );
    },

    block() {
      note(sfxBus, hz("D4"), at(), 0.1, 0.3, "sine", 0.02, 0.25);
    },

    miss() {
      step = 0;
      note(sfxBus, hz("Eb4"), at(), 0.1, 0.5, "sine", 0.02, 0.25);
      note(sfxBus, hz("D4"), at(0.085), 0.16, 0.45, "sine", 0.02, 0.3);
      note(sfxBus, hz("D3"), at(0.01), 0.1, 0.4, "sine", 0.01, 0.2);
    },

    pepper() {
      step = 0;
      note(sfxBus, hz("F3"), at(), 0.16, 0.5, "sine", 0.01, 0.25);
      note(sfxBus, hz("F4"), at(0.02), 0.16, 0.5, "sine", 0.02, 0.3);
      note(sfxBus, hz("Gb4"), at(0.03), 0.16, 0.42, "sine", 0.02, 0.3);
    },

    scorpion() {
      step = 0;
      note(sfxBus, hz("D3"), at(), 0.3, 0.55, "sine", 0.01, 0.35);
      glide("A5", "A2", 0.5, 0.1);
    },

    sweep() {
      ["C5", "E5", "G5", "A5", "C6"].forEach((n, i) =>
        note(sfxBus, hz(n), at(i * 0.045), 0.07, 0.24, "sine", 0.01, 0.2)
      );
    },

    gameOver() {
      step = 0;
      modeStack = [];
      applyMode();
      musicBus.gain.setTargetAtTime(db(-30), ctx.currentTime, 0.25);
      ["C5", "A4", "F4", "E4"].forEach((n, i) =>
        note(sfxBus, hz(n), at(0.1 + i * 0.16), 0.18, 0.5, "sine", 0.02, 0.3)
      );
      clearTimeout(menuTimer);
      menuTimer = setTimeout(() => {
        if (!disposed) api.menuMusic();
      }, 1200);
    },

    menuMusic() {
      modeStack = ["menu"];
      applyMode();
      startSeq();
    },

    startMusic() {
      clearTimeout(menuTimer);
      modeStack = [];
      applyMode();
      startSeq();
    },

    async setFocused(focused) {
      if (disposed) return;
      try {
        if (!focused) {
          stopSeq();
          if (ctx.state === "running") await ctx.suspend();
        } else {
          if (ctx.state === "suspended") await ctx.resume();
          startSeq();
        }
      } catch {}
    },

    async resume() {
      if (disposed) return;
      try {
        if (ctx.state === "suspended") await ctx.resume();
      } catch {}
    },

    setMuted(next) {
      muted = !!next;
      master.gain.setTargetAtTime(muted ? 0.0001 : db(-3), ctx.currentTime, 0.02);
    },

    dispose() {
      disposed = true;
      clearTimeout(menuTimer);
      stopSeq();
      droneOn(false);
      try {
        master.disconnect();
        sfxBus.disconnect();
        sfxFilter.disconnect();
        musicBus.disconnect();
        musicFilter.disconnect();
        ctx.close();
      } catch {}
    },
  };

  return api;
}
