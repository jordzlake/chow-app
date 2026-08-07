"use client";

/*
  All audio is synthesised with Tone.js — no files to fetch, nothing to 404.
  Tone is ~78 KB gzipped so it is dynamically imported on Start, behind the
  loading screen, rather than at page load.

  The bed is bossa nova: a syncopated comping figure over a two-feel bass with
  a soft rim playing the 3-2 bossa clave, on lazy major-seventh changes. Each
  timed power-up swaps the bed to its own mode and swaps back when it lapses.

  Everything is low and soft-edged: triangle and sine voices, no sharp attacks,
  a low-pass on every bus and one shared reverb.
*/

// C major pentatonic. Every catch walks one step up, so a clean run plays a
// rising phrase; a miss resets it to the bottom.
const SCALE = [
  "C4", "D4", "E4", "G4", "A4",
  "C5", "D5", "E5", "G5", "A5",
  "C6",
];
const WRAP_TO = 4; // once past the top, fall back here instead of going shrill

// Lazy major-seventh changes. Four bars, one chord each.
const PROGRESSIONS = {
  base: {
    chords: [
      ["C4", "E4", "G4", "B4"], // Cmaj7
      ["A3", "C4", "E4", "G4"], // Am7
      ["D4", "F4", "A4", "C5"], // Dm7
      ["G3", "B3", "D4", "F4"], // G7
    ],
    roots: ["C2", "A1", "D2", "G1"],
  },
  bright: {
    chords: [
      ["D4", "F#4", "A4", "C#5"], // Dmaj7
      ["B3", "D4", "F#4", "A4"], // Bm7
      ["E4", "G4", "B4", "D5"], // Em7
      ["A3", "C#4", "E4", "G4"], // A7
    ],
    roots: ["D2", "B1", "E2", "A1"],
  },
  // Slow and minor, for menus.
  minor: {
    chords: [
      ["A3", "C4", "E4", "G4"], // Am7
      ["D3", "F3", "A3", "C4"], // Dm7
      ["F3", "A3", "C4", "E4"], // Fmaj7
      ["E3", "G#3", "B3", "D4"], // E7
    ],
    roots: ["A1", "D2", "F2", "E2"],
  },
  dream: {
    chords: [
      ["F3", "A3", "C4", "E4"], // Fmaj7
      ["D3", "F3", "A3", "C4"], // Dm7
      ["G3", "B3", "D4", "F4"], // G7
      ["C4", "E4", "G4", "B4"], // Cmaj7
    ],
    roots: ["F2", "D2", "G1", "C2"],
  },
};

// How the bed reacts to each power-up.
const MODES = {
  // One level for every bed, so the music never changes loudness between the
  // menus, normal play and any power-up. Only tempo, filter and harmony move.
  base: { bpm: 128, filter: 2200, prog: "base", drone: false, vol: -10 },
  mango: { bpm: 142, filter: 3200, prog: "bright", drone: false, vol: -10 },
  shield: { bpm: 122, filter: 2000, prog: "base", drone: true, vol: -10 },
  bowl: { bpm: 100, filter: 2400, prog: "dream", drone: false, vol: -10 },
  menu: { bpm: 74, filter: 2000, prog: "minor", drone: false, vol: -10 },
};

// Four notes on pickup, one shape per power-up.
const MOTIFS = {
  mango: ["C5", "E5", "G5", "C6"],
  shield: ["E4", "B4", "E5", "G#5"],
  bowl: ["A4", "C5", "E5", "A5"],
  health: ["G4", "B4", "D5", "G5"],
};

export async function createAudio(rawContext) {
  const Tone = await import("tone");

  // The native context was created inside the click handler, so it already has
  // the user gesture it needs. Handing it to Tone keeps that permission.
  if (rawContext) Tone.setContext(rawContext);
  await Tone.start();

  const transport = Tone.getTransport();
  transport.bpm.value = MODES.base.bpm;

  /*
    Nothing in this chain compresses or limits. Tone's Limiter is a Compressor
    at ratio 20 with a 10 ms release, and any compressor sitting across a bus
    shared by music and effects will duck one with the other. Both are gone.

    The chain peaks around -25 dBFS, roughly 25 dB of headroom below clipping,
    so there is nothing for a limiter to protect against in the first place.
  */
  const master = new Tone.Volume(-3).toDestination();

  const reverb = new Tone.Reverb({ decay: 2.8, wet: 0.26 }).connect(master);
  await reverb.ready;

  // buses
  const sfxBus = new Tone.Volume(-9);
  const sfxFilter = new Tone.Filter(3400, "lowpass");
  sfxBus.connect(sfxFilter);
  sfxFilter.connect(reverb);

  const musicBus = new Tone.Volume(MODES.base.vol);
  const musicFilter = new Tone.Filter(MODES.base.filter, "lowpass");
  musicBus.connect(musicFilter);
  musicFilter.connect(reverb);

  /* ---------------------------------------------------------------- sfx */

  const pluck = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.28, sustain: 0, release: 0.35 },
  }).connect(sfxBus);
  // Generous on purpose. A low cap makes Tone steal a voice from a note that
  // is still sounding, and that abrupt cut is itself a click.
  pluck.maxPolyphony = 16;
  pluck.volume.value = -6;

  const soft = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.03, decay: 0.3, sustain: 0, release: 0.4 },
  }).connect(sfxBus);
  // Generous on purpose. A low cap makes Tone steal a voice from a note that
  // is still sounding, and that abrupt cut is itself a click.
  soft.maxPolyphony = 16;
  soft.volume.value = -4;

  // for rising and falling sweeps
  const laser = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.006, decay: 0.3, sustain: 0.15, release: 0.12 },
  }).connect(sfxBus);
  laser.volume.value = -16;

  const thud = new Tone.NoiseSynth({
    noise: { type: "brown" },
    envelope: { attack: 0.005, decay: 0.16, sustain: 0 },
  });
  const thudFilter = new Tone.Filter(950, "lowpass");
  thud.connect(thudFilter);
  thudFilter.connect(sfxBus);
  thud.volume.value = -16;

  /* -------------------------------------------------------------- music */

  const comp = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.012, decay: 0.9, sustain: 0.04, release: 0.7 },
  }).connect(musicBus);
  // Generous on purpose. A low cap makes Tone steal a voice from a note that
  // is still sounding, and that abrupt cut is itself a click.
  comp.maxPolyphony = 12;
  comp.volume.value = -9;

  const bass = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.02, decay: 0.5, sustain: 0.2, release: 0.5 },
  }).connect(musicBus);
  bass.volume.value = -6;

  const rim = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0 },
  });
  const rimFilter = new Tone.Filter(2400, "highpass");
  rim.connect(rimFilter);
  rimFilter.connect(musicBus);
  rim.volume.value = -30;

  const drone = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 1.6, decay: 0.4, sustain: 0.6, release: 2.6 },
  }).connect(musicBus);
  // Generous on purpose. A low cap makes Tone steal a voice from a note that
  // is still sounding, and that abrupt cut is itself a click.
  drone.maxPolyphony = 12;
  drone.volume.value = -20;

  let prog = PROGRESSIONS.base;

  // Bossa comping: bar one syncopates on the and-of-two, bar two pushes
  // earlier. The rim carries the 3-2 clave across the same two bars.
  const COMP_A = [0, 3, 6];
  const COMP_B = [0, 2, 5];
  const CLAVE_A = [0, 3, 6];
  const CLAVE_B = [2, 5];
  const BASS_HITS = [0, 4]; // two-feel: root on one, fifth on three

  // four bars of eighths, one chord per bar
  const EVENTS = [];
  for (let bar = 0; bar < 4; bar++) {
    for (let e = 0; e < 8; e++) EVENTS.push({ bar, e });
  }

  const seq = new Tone.Sequence(
    (time, v) => {
      const chord = prog.chords[v.bar];
      const root = prog.roots[v.bar];
      const odd = v.bar % 2 === 1;

      if ((odd ? COMP_B : COMP_A).includes(v.e)) {
        comp.triggerAttackRelease(chord, "8n", time, 0.16);
      }
      if (BASS_HITS.includes(v.e)) {
        bass.triggerAttackRelease(root, v.e === 0 ? "4n" : "8n", time, 0.3);
      }
      if ((odd ? CLAVE_B : CLAVE_A).includes(v.e)) {
        rim.triggerAttackRelease("32n", time, 0.22);
      }
    },
    EVENTS,
    "8n"
  );
  seq.start(0);

  /* ---------------------------------------------------------- scheduling */

  // Tone throws if two notes land on the exact same instant, which is easy to
  // hit when two fruit are caught on one frame. This keeps times increasing.
  // Everything is scheduled a little ahead of the clock. Firing a note at
  // exactly Tone.now() lands it on the very edge of the current render quantum,
  // where the gain change can be applied part-way through a buffer instead of
  // at a zero crossing. That discontinuity is the click. 25 ms of lead is
  // imperceptible as latency but puts every event safely in the future.
  const LEAD = 0.025;
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

    // Four notes up, then the bed changes character for as long as it runs.
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

    // Timer lapsed: hand the bed back to whatever else is still running.
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

    // The pineapple falls fast, so it gets a rising sweep on top of the run.
    bonus() {
      if (disposed) return;
      const t = at();
      laser.triggerAttack("C5", t);
      laser.frequency.exponentialRampTo("C7", 0.26, t);
      laser.triggerRelease(t + 0.3);
      ["G5", "A5", "C6", "E6"].forEach((n, i) =>
        pluck.triggerAttackRelease(n, "32n", at(i * 0.05), 0.4)
      );
    },

    // Health pickup with nothing to heal: a bright pair so the 100 points
    // still land as a reward rather than silence.
    fullHealth() {
      if (disposed) return;
      ["D5", "A5"].forEach((n, i) =>
        pluck.triggerAttackRelease(n, "16n", at(i * 0.08), 0.45)
      );
      soft.triggerAttackRelease("F#5", "8n", at(0.16), 0.35);
    },

    // Short rising blip as a fork fires.
    forkShot() {
      if (disposed) return;
      const t = at();
      laser.triggerAttack("E5", t);
      laser.frequency.exponentialRampTo("B6", 0.12, t);
      laser.triggerRelease(t + 0.15);
      pluck.triggerAttackRelease("B5", "32n", at(0.03), 0.35);
    },

    forkGained() {
      if (disposed) return;
      ["D5", "G5", "B5", "D6"].forEach((n, i) =>
        pluck.triggerAttackRelease(n, "16n", at(i * 0.07), 0.45)
      );
    },

    block() {
      if (disposed) return;
      soft.triggerAttackRelease("D4", "16n", at(), 0.3);
    },

    // A falling minor second. This used to sit on A2/G2, around 100 Hz, which
    // phone speakers simply do not reproduce, so the sound was inaudible on
    // the device it matters most on. Everything punitive now lives above
    // ~300 Hz, where a small speaker can carry it.
    miss() {
      if (disposed) return;
      step = 0;
      soft.triggerAttackRelease("Eb4", "16n", at(), 0.5);
      soft.triggerAttackRelease("D4", "8n", at(0.085), 0.45);
      thud.triggerAttackRelease("16n", at(0.01), 0.3);
    },

    pepper() {
      if (disposed) return;
      step = 0;
      thud.triggerAttackRelease("8n", at(), 0.6);
      // a flat second, which is what makes it read as a mistake
      soft.triggerAttackRelease("F4", "8n", at(0.02), 0.5);
      soft.triggerAttackRelease("Gb4", "8n", at(0.03), 0.42);
    },

    scorpion() {
      if (disposed) return;
      step = 0;
      thud.triggerAttackRelease("4n", at(), 0.6);
      const t = at();
      laser.triggerAttack("A5", t);
      laser.frequency.exponentialRampTo("A2", 0.5, t);
      laser.triggerRelease(t + 0.55);
    },

    // Rising run as the board wipes.
    sweep() {
      if (disposed) return;
      ["C5", "E5", "G5", "A5", "C6"].forEach((n, i) =>
        soft.triggerAttackRelease(n, "32n", at(i * 0.045), 0.24)
      );
    },

    // Losing screen: the bed drops away and a soft minor cadence lands.
    gameOver() {
      if (disposed) return;
      step = 0;
      modeStack = [];
      applyMode();
      musicBus.volume.rampTo(-30, 0.5);
      // then the slow minor menu bed fades back in under the score screen
      menuTimer = setTimeout(() => {
        if (!disposed) api.menuMusic();
      }, 1200);
      ["C5", "A4", "F4", "E4"].forEach((n, i) =>
        soft.triggerAttackRelease(n, "8n", at(0.1 + i * 0.16), 0.5)
      );
    },

    // Slow, minor, quieter. Used on the pause and score screens.
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
      applyMode(); // applyMode owns the level; do not set it again here
      if (transport.state !== "started") transport.start("+0.1");
    },

    // Called when the tab or window loses focus. Suspending the context stops
    // every voice at once and gives the CPU back.
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
        [pluck, soft, laser, thud, thudFilter, comp, bass, rim, rimFilter,
         drone, musicBus, musicFilter, sfxBus, sfxFilter, reverb,
         master].forEach((n) => n.dispose());
      } catch {}
    },
  };

  return api;
}
