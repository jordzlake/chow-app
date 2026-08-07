"use client";

/*
  Audio is loaded lazily. Tone.js is ~78 KB gzipped, which is more than the rest
  of the game put together, so it is dynamically imported the moment the player
  presses Start rather than on page load. Everything here is synthesised, so
  there are no audio files to fetch and nothing to 404.

  All of it is deliberately quiet and soft-edged: triangle and sine waves, no
  attack transients, a low-pass on every bus and a shared reverb.
*/

// C major pentatonic. Every catch walks one step up, so a clean run plays a
// rising phrase; a miss resets it to the bottom.
const SCALE = [
  "C4", "D4", "E4", "G4", "A4",
  "C5", "D5", "E5", "G5", "A5",
  "C6",
];
const WRAP_TO = 4; // once past the top, fall back here instead of going shrill

// A lazy, loping two-bar figure. Nulls are rests, and there are plenty.
const OSTINATO = [
  "C5", null, "E5", null, "G5", null, "E5", null,
  "A4", null, "C5", null, null, "G4", null, null,
  "D5", null, "G5", null, "E5", null, null, null,
  "C5", null, "A4", null, null, "E4", null, null,
];

const PADS = [
  ["C3", "E3", "G3"],
  ["A2", "C3", "E3"],
  ["F2", "A2", "C3"],
  ["G2", "B2", "D3"],
];

export async function createAudio(rawContext) {
  const Tone = await import("tone");

  // The native context was created inside the click handler, so it already has
  // the user gesture it needs. Handing it to Tone keeps that permission.
  if (rawContext) Tone.setContext(rawContext);
  await Tone.start();

  const limiter = new Tone.Limiter(-6).toDestination();
  const master = new Tone.Volume(-3).connect(limiter);

  const reverb = new Tone.Reverb({ decay: 2.8, wet: 0.26 }).connect(master);
  await reverb.ready;

  // buses
  const sfxBus = new Tone.Volume(-9);
  const sfxFilter = new Tone.Filter(3400, "lowpass");
  sfxBus.connect(sfxFilter);
  sfxFilter.connect(reverb);

  const musicBus = new Tone.Volume(-26);
  const musicFilter = new Tone.Filter(2200, "lowpass");
  musicBus.connect(musicFilter);
  musicFilter.connect(reverb);

  // voices
  const pluck = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.28, sustain: 0, release: 0.35 },
  }).connect(sfxBus);
  pluck.volume.value = -6;

  const soft = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.03, decay: 0.3, sustain: 0, release: 0.4 },
  }).connect(sfxBus);
  soft.volume.value = -8;

  const thud = new Tone.NoiseSynth({
    noise: { type: "brown" },
    envelope: { attack: 0.005, decay: 0.16, sustain: 0 },
  });
  const thudFilter = new Tone.Filter(420, "lowpass");
  thud.connect(thudFilter);
  thudFilter.connect(sfxBus);
  thud.volume.value = -26;

  const marimba = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.008, decay: 0.5, sustain: 0, release: 0.6 },
  }).connect(musicBus);

  const pad = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 1.4, decay: 0.6, sustain: 0.35, release: 2.4 },
  }).connect(musicBus);
  pad.volume.value = -12;

  // background bed. Tone.Transport is deprecated in v15, so go through
  // getTransport() instead.
  const transport = Tone.getTransport();
  transport.bpm.value = 84;

  // Tone throws if two notes are scheduled at the exact same instant, which is
  // easy to hit when two fruit land on one frame. This keeps times increasing.
  let lastAt = 0;
  const at = (offset) => {
    const now = Tone.now() + (offset || 0);
    lastAt = Math.max(now, lastAt + 0.015);
    return lastAt;
  };

  let step = 0;
  let disposed = false;

  const api = {
    catchFruit() {
      if (disposed) return;
      const note = SCALE[Math.min(step, SCALE.length - 1)];
      pluck.triggerAttackRelease(note, "16n", at(), 0.5);
      step = step + 1 >= SCALE.length ? WRAP_TO : step + 1;
    },

    // A run of catches builds the phrase; losing one drops you back down.
    resetPhrase() {
      step = 0;
    },

    power() {
      if (disposed) return;
      ["C5", "E5", "G5"].forEach((n, i) =>
        pluck.triggerAttackRelease(n, "16n", at(i * 0.06), 0.45)
      );
    },

    bonus() {
      if (disposed) return;
      ["G5", "A5", "C6", "E6"].forEach((n, i) =>
        pluck.triggerAttackRelease(n, "32n", at(i * 0.045), 0.4)
      );
    },

    heal() {
      if (disposed) return;
      soft.triggerAttackRelease("G4", "8n", at(), 0.4);
      soft.triggerAttackRelease("C5", "4n", at(0.1), 0.4);
    },

    block() {
      if (disposed) return;
      soft.triggerAttackRelease("D4", "16n", at(), 0.3);
    },

    // Deliberately small: a soft low pair, not a buzzer.
    miss() {
      if (disposed) return;
      step = 0;
      soft.triggerAttackRelease("A2", "16n", at(), 0.32);
      soft.triggerAttackRelease("G2", "8n", at(0.09), 0.28);
    },

    pepper() {
      if (disposed) return;
      step = 0;
      thud.triggerAttackRelease("8n", at(), 0.5);
      soft.triggerAttackRelease("F2", "8n", at(0.02), 0.3);
    },

    scorpion() {
      if (disposed) return;
      step = 0;
      thud.triggerAttackRelease("4n", at(), 0.6);
      ["F3", "D3", "A2"].forEach((n, i) =>
        soft.triggerAttackRelease(n, "8n", at(i * 0.13), 0.35)
      );
    },

    sweep() {
      if (disposed) return;
      ["C5", "G4", "E4"].forEach((n, i) =>
        soft.triggerAttackRelease(n, "16n", at(i * 0.05), 0.22)
      );
    },

    startMusic() {
      if (disposed) return;
      musicBus.volume.rampTo(-26, 1.2);
      if (transport.state !== "started") transport.start("+0.1");
    },

    // Not stopped outright between runs, just pulled back, so menus stay calm.
    duckMusic() {
      if (disposed) return;
      musicBus.volume.rampTo(-38, 0.8);
    },

    setMuted(muted) {
      if (disposed) return;
      master.mute = !!muted;
    },

    dispose() {
      disposed = true;
      try {
        transport.stop();
        transport.cancel();
        seq.dispose();
        padLoop.dispose();
        [pluck, soft, thud, thudFilter, marimba, pad, musicBus, musicFilter,
         sfxBus, sfxFilter, reverb, master, limiter].forEach((n) => n.dispose());
      } catch {}
    },
  };

  const seq = new Tone.Sequence(
    (time, note) => {
      if (note) marimba.triggerAttackRelease(note, "8n", time, 0.32);
    },
    OSTINATO,
    "8n"
  );
  seq.start(0);

  let padIndex = 0;
  const padLoop = new Tone.Loop((time) => {
    pad.triggerAttackRelease(PADS[padIndex % PADS.length], "1m", time, 0.22);
    padIndex += 1;
  }, "1m");
  padLoop.start(0);

  return api;
}
