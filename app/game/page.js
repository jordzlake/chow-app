"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createAudio } from "./audio";

/* Smaller fruit is worth more. `unlock` is the score at which that size joins
   the pool, so the drop mix widens as the run goes rather than all at once.
   Colours are HSL so each drop can jitter its own hue slightly. */
const FRUITS = [
  { key: "grapefruit", shape: "round", scale: 1.3, points: 5, hue: 2, sat: 78, light: 60, unlock: 0, weight: 3 },
  { key: "orange", shape: "round", scale: 1.0, points: 10, hue: 28, sat: 96, light: 55, unlock: 0, weight: 4 },
  { key: "lemon", shape: "round", scale: 0.86, points: 15, hue: 50, sat: 100, light: 52, unlock: 150, weight: 3 },
  { key: "cucumber", shape: "long", scale: 1.15, points: 8, hue: 102, sat: 44, light: 40, unlock: 250, weight: 3 },
  { key: "lime", shape: "round", scale: 0.66, points: 30, hue: 82, sat: 72, light: 44, unlock: 500, weight: 3 },
  { key: "apple", shape: "apple", scale: 0.92, points: 20, hue: 352, sat: 78, light: 48, unlock: 700, weight: 3 },
  { key: "kumquat", shape: "round", scale: 0.46, points: 60, hue: 33, sat: 100, light: 56, unlock: 900, weight: 2 },
  { key: "cherries", shape: "cherries", scale: 0.5, points: 80, hue: 344, sat: 80, light: 44, unlock: 1200, weight: 2 },
];

const POWERS = {
  mango: { label: "Catch all", seconds: 9, color: "#ff8a1e", timed: true },
  health: { label: "+1 Health", seconds: 0, color: "#ff5e6c", timed: false },
  shield: { label: "Shield", seconds: 7, color: "#17a9a0", timed: true },
  bowl: { label: "Fruit bowl", seconds: 10, color: "#ec1163", timed: true },
};

const POWER_KEYS = Object.keys(POWERS);
const TIMED_KEYS = POWER_KEYS.filter((k) => POWERS[k].timed);

const START_LIVES = 3;
const MAX_LIVES = START_LIVES; // three hearts is full; extras are not banked

const SCORPION_SCORE = 500; // scorpion peppers join the mix here

// The pineapple slice is a bonus, not an effect: it runs on its own timer at
// three times the gap of a normal power-up, so it stays a rare sighting, and
// it drops five times faster than anything else on screen.
const PINEAPPLE_POINTS = 150;
const PINEAPPLE_SPEED = 5;
const SKY_STEP = 50; // the sky shifts hue every this many points
const SKY_END = 1500; // and lands on yellow here
const SKY_FROM = 215; // blue
const SKY_SPAN = 193; // through violet, magenta and orange to yellow

export default function GamePage() {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const audioRef = useRef(null);

  const [phase, setPhase] = useState("ready"); // ready | playing | paused | over
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(START_LIVES);
  const [best, setBest] = useState(0);
  const [active, setActive] = useState([]); // live power-up timers for the HUD
  const [hurt, setHurt] = useState(0); // timestamp of the last hit, keys the red flash
  const [heal, setHeal] = useState(0); // and of the last heart gained, keys the green one

  const [name, setName] = useState("");
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [saveNote, setSaveNote] = useState("");
  const [board, setBoard] = useState(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [howTo, setHowTo] = useState(false);
  const [booting, setBooting] = useState(false); // audio is loading
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    try {
      setName(localStorage.getItem("chow-name") || "");
      setBest(Number(localStorage.getItem("chow-best") || 0));
      setMuted(localStorage.getItem("chow-muted") === "1");
    } catch {}
  }, []);

  /* ------------------------------------------------------------ engine */

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext("2d", { alpha: false });

    const g = {
      w: 0,
      h: 0,
      unit: 1,
      phase: "ready",
      fruits: [],
      bits: [],
      pops: [],
      rings: [],
      motes: [],
      bowl: { x: 0, y: 0, w: 120, baseW: 120, h: 46, target: 0 },
      fx: { mango: 0, shield: 0, bowl: 0 },
      lastPower: "mango",
      hue: SKY_FROM,
      dragging: false,
      elapsed: 0,
      caught: 0,
      lives: START_LIVES,
      score: 0,
      nextDrop: 0,
      nextPower: 0,
      nextBonus: 0,
      powerOut: false,
      shake: 0,
      hudTick: 0,
      hudSig: "",
      raf: 0,
      last: 0,
    };
    gameRef.current = g;

    const seedMotes = () => {
      g.motes = [];
      const count = Math.round((g.w * g.h) / 42000);
      for (let i = 0; i < count; i++) {
        g.motes.push({
          x: Math.random() * g.w,
          y: Math.random() * g.h,
          r: 0.8 + Math.random() * 1.7,
          vy: 6 + Math.random() * 16,
          a: 0.12 + Math.random() * 0.24,
          drift: (Math.random() - 0.5) * 8,
        });
      }
    };

    const layout = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      g.w = rect.width;
      g.h = rect.height;
      g.unit = Math.max(0.7, Math.min(g.h / 720, 1.5));

      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      g.bowl.baseW = Math.max(94, Math.min(g.w * 0.3, 170));
      g.bowl.h = g.bowl.baseW * 0.4; // height stays put even when Catch all widens the bowl
      g.bowl.y = g.h - g.bowl.h - Math.max(56, g.h * 0.11);
      if (g.fx.mango <= 0) g.bowl.w = g.bowl.baseW;
      if (!g.bowl.x) {
        g.bowl.x = g.w / 2;
        g.bowl.target = g.w / 2;
      }
      clampBowl();
      seedMotes();

      // A rotation or keyboard resize changes the reachable band, so pull any
      // fruit already falling back inside it.
      for (const f of g.fruits) {
        const { lo, hi } = dropRange(f.r);
        f.x = Math.max(lo, Math.min(hi, f.x));
      }
    };

    const clampBowl = () => {
      const half = g.bowl.w / 2;
      g.bowl.target = Math.max(half, Math.min(g.w - half, g.bowl.target));
      g.bowl.x = Math.max(half, Math.min(g.w - half, g.bowl.x));
    };

    /* ------------------------------------------------------- controls */

    const pointerX = (event) => event.clientX - wrap.getBoundingClientRect().left;

    const onDown = (event) => {
      if (g.phase !== "playing") return;
      g.dragging = true;
      g.bowl.target = pointerX(event);
      clampBowl();
      try {
        wrap.setPointerCapture(event.pointerId);
      } catch {}
    };

    const onMove = (event) => {
      if (!g.dragging || g.phase !== "playing") return;
      event.preventDefault();
      g.bowl.target = pointerX(event);
      clampBowl();
    };

    const onUp = () => {
      g.dragging = false;
    };

    wrap.addEventListener("pointerdown", onDown);
    wrap.addEventListener("pointermove", onMove, { passive: false });
    wrap.addEventListener("pointerup", onUp);
    wrap.addEventListener("pointercancel", onUp);

    /* ---------------------------------------------------------- spawn */

    // Fruit only drops where the bowl can sit centred under it. The bowl's
    // centre is clamped to [half, w - half], so anything outside that band
    // needs the bowl pinned against a wall to reach. The fruit's own radius is
    // taken off both ends again so no fruit is ever clipped by the screen.
    // Always measured against the base width, never the widened Catch all bowl.
    const dropRange = (r) => {
      const half = g.bowl.baseW / 2;
      const edge = r + 10;
      const lo = Math.max(edge, half);
      const hi = Math.min(g.w - edge, g.w - half);
      return hi > lo ? { lo, hi } : { lo: g.w / 2, hi: g.w / 2 };
    };

    const baseRadius = () => Math.max(15, Math.min(g.w, 460) * 0.055);

    // Half the old ramp, then the whole curve taken down another fifth.
    const fallSpeed = () =>
      (172 + g.elapsed * 5.2 + g.caught * 3.6) * g.unit * (0.9 + Math.random() * 0.25);

    const pickFruit = () => {
      const pool = FRUITS.filter((f) => g.score >= f.unlock);
      const total = pool.reduce((sum, f) => sum + f.weight, 0);
      let roll = Math.random() * total;
      for (const f of pool) {
        roll -= f.weight;
        if (roll <= 0) return f;
      }
      return pool[pool.length - 1];
    };

    const place = (r) => {
      const { lo, hi } = dropRange(r);
      return lo + Math.random() * (hi - lo);
    };

    const spawnFruit = () => {
      // Fruit bowl is a pure scoring window: no peppers while it runs, and
      // they resume the moment it drops.
      const pepper = g.caught >= 4 && g.fx.bowl <= 0 && Math.random() < 0.16;

      if (pepper) {
        const scorpion = g.score >= SCORPION_SCORE && Math.random() < 0.18;
        const r = baseRadius() * (scorpion ? 1.12 : 1);
        g.fruits.push({
          kind: "pepper",
          scorpion,
          x: place(r),
          y: -r * 2,
          prevBottom: -r,
          r,
          points: 0,
          flesh: scorpion ? "#ff2424" : "#d21414",
          skin: scorpion ? "#c20000" : "#7a0b0b",
          spin: (Math.random() - 0.5) * 0.7,
          rot: Math.random() * Math.PI,
          seed: Math.random() * 12,
          vy: fallSpeed(),
        });
        return;
      }

      const kind = pickFruit();
      const r = baseRadius() * kind.scale;
      // slight hue and lightness jitter so no two drops look identical
      const hue = kind.hue + (Math.random() - 0.5) * 22;
      const light = kind.light + (Math.random() - 0.5) * 8;

      g.fruits.push({
        kind: "fruit",
        x: place(r),
        y: -r * 2,
        prevBottom: -r,
        r,
        points: kind.points,
        shape: kind.shape,
        flesh: `hsl(${hue}, ${kind.sat}%, ${light}%)`,
        skin: `hsl(${hue - 4}, ${kind.sat}%, ${Math.max(18, light - 17)}%)`,
        shine: `hsla(${hue + 16}, 100%, 92%, 0.6)`,
        spin: (Math.random() - 0.5) * 0.9, // slow tumble
        rot: Math.random() * Math.PI * 2,
        seed: Math.random() * 12,
        vy: fallSpeed(),
      });
    };

    const spawnPower = () => {
      const key = POWER_KEYS[(Math.random() * POWER_KEYS.length) | 0];
      const r = baseRadius() * 1.05;

      g.fruits.push({
        kind: "power",
        power: key,
        x: place(r),
        y: -r * 2,
        prevBottom: -r,
        r,
        points: 0,
        flesh: POWERS[key].color,
        skin: "#ffffff",
        spin: 0,
        rot: 0,
        seed: Math.random() * 12,
        vy: fallSpeed() * 0.62, // drifts down slower so it stays winnable
      });
      g.powerOut = true;
    };

    const spawnBonus = () => {
      const r = baseRadius() * 1.15;
      g.fruits.push({
        kind: "bonus",
        x: place(r),
        y: -r * 2.5,
        prevBottom: -r * 1.5,
        r,
        points: PINEAPPLE_POINTS,
        flesh: "#ffd400",
        skin: "#e0951a",
        spin: 2.6,
        rot: Math.random() * Math.PI,
        seed: Math.random() * 12,
        vy: fallSpeed() * PINEAPPLE_SPEED,
      });
    };

    const burst = (x, y, color) => {
      for (let i = 0; i < 7; i++) {
        g.bits.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 240,
          vy: -Math.random() * 220 - 40,
          life: 0.55,
          color,
          r: 2 + Math.random() * 3,
        });
      }
      // a few white sparks on top, they read as juice at any background hue
      for (let i = 0; i < 5; i++) {
        g.bits.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 300,
          vy: -Math.random() * 260 - 30,
          life: 0.45,
          color: "#ffffff",
          r: 1 + Math.random() * 1.8,
        });
      }
      if (g.bits.length > 120) g.bits.splice(0, g.bits.length - 120);
    };

    const ring = (x, y, color, delay) => {
      g.rings.push({ x, y, r: 8, life: 0.75, max: 0.75, color, delay: delay || 0 });
    };

    const puff = (x, y) => {
      for (let i = 0; i < 4; i++) {
        g.bits.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 150,
          vy: -Math.random() * 120 - 20,
          life: 0.4,
          color: "#ffffff",
          r: 1.5 + Math.random() * 2.5,
        });
      }
    };

    // A power-up ending leaves a crowded screen behind. Wipe what is still
    // falling so normal play does not resume mid-avalanche. Power-ups are left
    // alone, and nothing cleared this way costs a life.
    const sweep = (endedKey) => {
      let cleared = 0;
      for (let i = g.fruits.length - 1; i >= 0; i--) {
        if (g.fruits[i].kind === "power" || g.fruits[i].kind === "bonus") continue;
        const f = g.fruits[i];
        g.fruits.splice(i, 1);
        if (cleared < 8) puff(f.x, f.y);
        cleared += 1;
      }
      if (cleared > 0) {
        ring(g.bowl.x, g.bowl.y, "#ffffff", 0);
        ring(g.bowl.x, g.bowl.y, POWERS[endedKey || "bowl"].color, 0.12);
        pop(g.w / 2, g.h * 0.42, "Cleared", "#ffffff", 20);
        audioRef.current?.sweep();
      }
    };

    const pop = (x, y, text, color, size) => {
      g.pops.push({ x, y, text, color, life: 0.8, size: size || 18 });
      if (g.pops.length > 12) g.pops.shift();
    };

    /* --------------------------------------------------------- update */

    // Catch all pushes fruit down harder, Fruit bowl drags it to a crawl.
    const fallMultiplier = () =>
      (g.fx.mango > 0 ? 1.5 : 1) * (g.fx.bowl > 0 ? 0.4 : 1);

    const loseLife = (x, y) => {
      // Fruit bowl is a free scoring window, so a drop during it costs nothing.
      // Kept quiet rather than popping text, since drops come thick and fast.
      if (g.fx.bowl > 0 && g.fx.shield <= 0) {
        puff(x, y);
        return;
      }
      if (g.fx.shield > 0) {
        audioRef.current?.block();
        burst(x, y, POWERS.shield.color);
        pop(x, y, "Blocked", POWERS.shield.color, 16);
        return;
      }
      audioRef.current?.miss();
      g.lives -= 1;
      g.shake = 0.3;
      setLives(g.lives);
      setHurt(performance.now()); // restarts the red edge flash
      if (g.lives <= 0) end();
    };

    const update = (dt) => {
      g.elapsed += dt;

      let endedKey = null;
      for (const key of TIMED_KEYS) {
        const wasUp = g.fx[key] > 0;
        if (wasUp) g.fx[key] = Math.max(0, g.fx[key] - dt);
        if (wasUp && g.fx[key] <= 0) endedKey = key;
      }
      // Every power-up ends with a clean screen, so the run never resumes
      // with a backlog already halfway down.
      if (endedKey) sweep(endedKey);

      // sky steps every SKY_STEP points, then eases toward the new hue
      const step = Math.min(SKY_END / SKY_STEP, Math.floor(g.score / SKY_STEP));
      // eased so the sky holds its blues and violets, and only turns yellow
      // in the last stretch before SKY_END
      const linear = step / (SKY_END / SKY_STEP);
      const wantHue = SKY_FROM + Math.pow(linear, 1.7) * SKY_SPAN;
      g.hue += (wantHue - g.hue) * Math.min(1, dt * 2.2);

      // bowl width eases toward its target so Catch all reads as a sweep
      const wantW = g.fx.mango > 0 ? g.w : g.bowl.baseW;
      g.bowl.w += (wantW - g.bowl.w) * Math.min(1, dt * 12);
      if (Math.abs(wantW - g.bowl.w) < 0.5) g.bowl.w = wantW;

      // bowl follows the finger, smoothed just enough to kill jitter
      g.bowl.x += (g.bowl.target - g.bowl.x) * Math.min(1, dt * 24);
      clampBowl();

      g.nextDrop -= dt * 1000;
      if (g.nextDrop <= 0) {
        spawnFruit();
        if (g.fx.bowl > 0) spawnFruit(); // Fruit bowl doubles the drop
        // same curve stretched by a fifth, so drops arrive 20% less often
        g.nextDrop = Math.max(412, 1188 - g.elapsed * 26 - g.caught * 14);
      }

      // One power-up on screen at a time: the first around 10s in, then every
      // 12-19s. With ~5s effects and imperfect catching that leaves an effect
      // running roughly a fifth of the time, so they stay a treat.
      g.nextPower -= dt * 1000;
      if (g.nextPower <= 0 && g.caught >= 3) {
        if (g.powerOut) {
          g.nextPower = 1500;
        } else {
          spawnPower();
          g.nextPower = 12000 + Math.random() * 7000;
        }
      }

      g.nextBonus -= dt * 1000;
      if (g.nextBonus <= 0 && g.caught >= 3) {
        spawnBonus();
        g.nextBonus = 36000 + Math.random() * 21000;
      }

      const rimY = g.bowl.y;
      const half = g.bowl.w / 2;
      const mul = fallMultiplier();

      for (let i = g.fruits.length - 1; i >= 0; i--) {
        const f = g.fruits[i];
        f.prevBottom = f.y + f.r;
        f.y += f.vy * mul * dt;
        f.rot += f.spin * dt;

        const bottom = f.y + f.r;
        const crossedRim = f.prevBottom <= rimY && bottom >= rimY;
        const overBowl = Math.abs(f.x - g.bowl.x) <= half;

        // the pineapple leaves a bright trail, which is what sells the speed
        if (f.kind === "bonus" && Math.random() < dt * 90) {
          g.bits.push({
            x: f.x + (Math.random() - 0.5) * f.r * 1.2,
            y: f.y - f.r * 0.6,
            vx: (Math.random() - 0.5) * 30,
            vy: -60 - Math.random() * 60,
            life: 0.35,
            rise: true,
            color: Math.random() < 0.5 ? "#ffffff" : "#ffe14d",
            r: 1.2 + Math.random() * 2.2,
          });
        }

        // embers trail off a burning pepper
        if (f.kind === "pepper" && Math.random() < dt * (f.scorpion ? 26 : 14)) {
          g.bits.push({
            x: f.x + (Math.random() - 0.5) * f.r,
            y: f.y - f.r * 0.9,
            vx: (Math.random() - 0.5) * 40,
            vy: -30 - Math.random() * 50,
            life: 0.45,
            rise: true,
            color: f.scorpion
              ? Math.random() < 0.5
                ? "#ffffff"
                : "#ffd84d"
              : Math.random() < 0.5
              ? "#ffd84d"
              : "#ff8a1e",
            r: 1.5 + Math.random() * 2,
          });
        }

        if (crossedRim && overBowl) {
          g.fruits.splice(i, 1);

          if (f.kind === "power") {
            g.powerOut = false;
            const spec = POWERS[f.power];
            g.lastPower = f.power;
            burst(f.x, rimY, spec.color);
            ring(f.x, rimY, spec.color, 0);
            ring(f.x, rimY, "#ffffff", 0.12);

            if (f.power === "health") {
              if (g.lives < MAX_LIVES) {
                g.lives += 1;
                setLives(g.lives);
                setHeal(performance.now()); // green edge glow
                audioRef.current?.heal();
                pop(f.x, rimY - 14, "+1 Health", spec.color, 19);
              } else {
                // already at full health: no extra heart is banked, so the
                // drop pays out in points instead of being wasted
                g.score += 100;
                setScore(g.score);
                pop(f.x, rimY - 14, "Full health +100", spec.color, 18);
              }
            } else {
              g.fx[f.power] = spec.seconds; // refreshes rather than stacks
              audioRef.current?.power();
              pop(f.x, rimY - 14, spec.label, spec.color, 19);
            }
          } else if (f.kind === "bonus") {
            g.score += f.points;
            setScore(g.score);
            audioRef.current?.bonus();
            burst(f.x, rimY, "#ffd400");
            burst(f.x, rimY, "#ffffff");
            ring(f.x, rimY, "#ffe14d", 0);
            ring(f.x, rimY, "#ffffff", 0.1);
            ring(f.x, rimY, "#ffd400", 0.2);
            pop(f.x, rimY - 16, `+${f.points}`, "#ffe14d", 26);
          } else if (f.kind === "pepper") {
            if (g.fx.mango > 0) {
              // Catch all is a fire of its own; peppers burn up harmlessly.
              audioRef.current?.block();
              burst(f.x, rimY, "#ffb020");
              pop(f.x, rimY - 12, "Burned up", "#ffd84d", 17);
            } else if (f.scorpion) {
              // Nothing survives a scorpion. Shield does not cover this.
              audioRef.current?.scorpion();
              burst(f.x, rimY, "#ff2424");
              ring(f.x, rimY, "#ff2424", 0);
              g.lives = 0;
              g.shake = 0.6;
              setLives(0);
              setHurt(performance.now());
              pop(f.x, rimY - 14, "Scorpion!", "#ff5e6c", 22);
              end();
            } else {
              audioRef.current?.pepper();
              burst(f.x, rimY, "#e02020");
              loseLife(f.x, rimY);
            }
          } else {
            g.caught += 1;
            g.score += f.points;
            audioRef.current?.catchFruit();
            burst(f.x, rimY, f.flesh);
            pop(f.x, rimY - 10, `+${f.points}`, "#ffffff", f.points >= 30 ? 22 : 17);
            setScore(g.score);
          }
          continue;
        }

        if (f.y - f.r > g.h + 20) {
          g.fruits.splice(i, 1);
          // A missed power-up is just a missed chance, never a lost life.
          if (f.kind === "power") g.powerOut = false;
          else if (f.kind === "fruit") loseLife(f.x, g.h - 40);
        }
      }

      for (let i = g.bits.length - 1; i >= 0; i--) {
        const b = g.bits[i];
        b.life -= dt;
        if (b.life <= 0) {
          g.bits.splice(i, 1);
          continue;
        }
        b.vy += (b.rise ? -190 : 900) * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      }

      for (let i = g.rings.length - 1; i >= 0; i--) {
        const rg = g.rings[i];
        if (rg.delay > 0) {
          rg.delay -= dt;
          continue;
        }
        rg.life -= dt;
        rg.r += 520 * dt;
        if (rg.life <= 0) g.rings.splice(i, 1);
      }

      for (const m of g.motes) {
        m.y -= m.vy * dt;
        m.x += m.drift * dt;
        if (m.y < -4) {
          m.y = g.h + 4;
          m.x = Math.random() * g.w;
        }
      }

      for (let i = g.pops.length - 1; i >= 0; i--) {
        const p = g.pops[i];
        p.life -= dt;
        p.y -= 46 * dt;
        if (p.life <= 0) g.pops.splice(i, 1);
      }

      if (g.shake > 0) g.shake = Math.max(0, g.shake - dt);

      // Feed the HUD ten times a second instead of every frame.
      g.hudTick += dt;
      if (g.hudTick >= 0.1) {
        g.hudTick = 0;
        const live = TIMED_KEYS.filter((k) => g.fx[k] > 0).map((k) => ({
          key: k,
          label: POWERS[k].label,
          color: POWERS[k].color,
          left: g.fx[k],
          pct: Math.max(0, Math.min(1, g.fx[k] / POWERS[k].seconds)),
        }));
        const sig = live.map((p) => `${p.key}${p.left.toFixed(1)}`).join("|");
        if (sig !== g.hudSig) {
          g.hudSig = sig;
          setActive(live);
        }
      }
    };

    const end = () => {
      audioRef.current?.duckMusic();
      g.phase = "over";
      g.dragging = false;
      for (const key of TIMED_KEYS) g.fx[key] = 0;
      setActive([]);
      setPhase("over");
      setSaveState("idle");
      setSaveNote("");
      try {
        const prevBest = Number(localStorage.getItem("chow-best") || 0);
        if (g.score > prevBest) {
          localStorage.setItem("chow-best", String(g.score));
          setBest(g.score);
        }
      } catch {}
    };

    /* ----------------------------------------------------------- draw */

    const drawSky = () => {
      const h = g.hue;
      const grad = ctx.createLinearGradient(0, 0, 0, g.h);
      grad.addColorStop(0, `hsl(${h}, 74%, 73%)`);
      grad.addColorStop(0.52, `hsl(${h + 10}, 78%, 63%)`);
      grad.addColorStop(1, `hsl(${h + 42}, 55%, 48%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, g.w, g.h);

      // drifting motes
      ctx.fillStyle = "#ffffff";
      for (const m of g.motes) {
        ctx.globalAlpha = m.a;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    // While an effect runs, scroll a soft diagonal stripe pattern in its colour.
    const drawPowerPattern = () => {
      const key = TIMED_KEYS.find((k) => g.fx[k] > 0);
      if (!key) return;
      const fade = Math.min(1, g.fx[key] / 0.8);
      const gap = 62;
      const offset = (g.elapsed * 80) % gap;

      ctx.save();
      ctx.globalAlpha = 0.11 * fade;
      ctx.fillStyle = POWERS[key].color;
      ctx.translate(-g.h * 0.4, 0);
      ctx.rotate(-0.42);
      const span = g.w + g.h * 1.6;
      for (let x = -gap; x < span; x += gap) {
        ctx.fillRect(x + offset, -g.h, gap * 0.42, g.h * 3);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    const drawCitrus = (f) => {
      ctx.fillStyle = f.skin;
      ctx.beginPath();
      ctx.arc(0, f.r * 0.08, f.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = f.flesh;
      ctx.beginPath();
      ctx.arc(0, 0, f.r * 0.94, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = f.shine || "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.ellipse(-f.r * 0.32, -f.r * 0.38, f.r * 0.26, f.r * 0.17, -0.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#3f7d1f";
      ctx.beginPath();
      ctx.ellipse(f.r * 0.42, -f.r * 0.72, f.r * 0.3, f.r * 0.15, -0.7, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawCucumber = (f) => {
      const r = f.r;
      ctx.fillStyle = f.skin;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.44, r * 1.05, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = f.flesh;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.37, r * 0.98, 0, 0, Math.PI * 2);
      ctx.fill();

      // ridges down the length
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = Math.max(1.5, r * 0.07);
      ctx.lineCap = "round";
      for (const dx of [-0.16, 0.02, 0.18]) {
        ctx.beginPath();
        ctx.moveTo(r * dx, -r * 0.62);
        ctx.lineTo(r * dx, r * 0.62);
        ctx.stroke();
      }
      ctx.fillStyle = f.shine || "rgba(255,255,255,0.4)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.16, -r * 0.42, r * 0.08, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      // blossom end
      ctx.fillStyle = "#dfe8b8";
      ctx.beginPath();
      ctx.ellipse(0, r * 1.0, r * 0.1, r * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawApple = (f) => {
      const r = f.r;
      // two lobes give the apple its dip at the top
      ctx.fillStyle = f.skin;
      ctx.beginPath();
      ctx.arc(-r * 0.32, r * 0.06, r * 0.72, 0, Math.PI * 2);
      ctx.arc(r * 0.32, r * 0.06, r * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = f.flesh;
      ctx.beginPath();
      ctx.arc(-r * 0.3, r * 0.02, r * 0.67, 0, Math.PI * 2);
      ctx.arc(r * 0.3, r * 0.02, r * 0.67, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = f.shine || "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.46, -r * 0.34, r * 0.2, r * 0.13, -0.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#6b3b17";
      ctx.lineWidth = Math.max(2, r * 0.11);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.58);
      ctx.quadraticCurveTo(r * 0.12, -r * 0.95, r * 0.04, -r * 1.12);
      ctx.stroke();
      ctx.fillStyle = "#3f7d1f";
      ctx.beginPath();
      ctx.ellipse(r * 0.35, -r * 0.92, r * 0.28, r * 0.13, -0.5, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawCherries = (f) => {
      const r = f.r;
      // stems first, meeting at a single joint
      ctx.strokeStyle = "#5f8b28";
      ctx.lineWidth = Math.max(2, r * 0.13);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.15);
      ctx.quadraticCurveTo(-r * 0.5, -r * 0.85, -r * 0.52, -r * 0.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.15);
      ctx.quadraticCurveTo(r * 0.55, -r * 0.8, r * 0.5, -r * 0.05);
      ctx.stroke();

      for (const [cx, cy, rad] of [
        [-r * 0.52, r * 0.36, r * 0.62],
        [r * 0.5, r * 0.5, r * 0.68],
      ]) {
        ctx.fillStyle = f.skin;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = f.flesh;
        ctx.beginPath();
        ctx.arc(cx, cy - rad * 0.05, rad * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = f.shine || "rgba(255,255,255,0.5)";
        ctx.beginPath();
        ctx.ellipse(cx - rad * 0.3, cy - rad * 0.35, rad * 0.24, rad * 0.15, -0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const drawFruit = (f) => {
      if (f.shape === "long") drawCucumber(f);
      else if (f.shape === "apple") drawApple(f);
      else if (f.shape === "cherries") drawCherries(f);
      else drawCitrus(f);
    };

    // A rounded, curling flame. `sway` bends the tip so each one flickers on
    // its own phase, and the base closes as a bulb rather than a flat cut.
    const tongue = (x, baseY, w, h, sway, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - w, baseY);
      ctx.bezierCurveTo(
        x - w * 1.15, baseY - h * 0.4,
        x - w * 0.85 + sway * 0.5, baseY - h * 0.76,
        x + sway, baseY - h
      );
      ctx.bezierCurveTo(
        x + w * 0.9 + sway * 0.5, baseY - h * 0.72,
        x + w * 1.15, baseY - h * 0.36,
        x + w, baseY
      );
      ctx.bezierCurveTo(
        x + w * 1.02, baseY + w * 0.98,
        x - w * 1.02, baseY + w * 0.98,
        x - w, baseY
      );
      ctx.closePath();
      ctx.fill();
    };

    const drawPepper = (f) => {
      const r = f.r;
      const t = g.elapsed;
      const hot = f.scorpion;
      const a = Math.sin(t * (hot ? 19 : 13) + f.seed);
      const b = Math.sin(t * (hot ? 13 : 9.3) + f.seed * 2.4 + 1.1);
      const c = Math.sin(t * (hot ? 23 : 17) + f.seed * 1.7 + 2.2);

      // heat halo, dark enough to hold up on any sky hue
      ctx.fillStyle = hot ? "rgba(255,60,0,0.3)" : "rgba(200,25,0,0.15)";
      ctx.beginPath();
      ctx.arc(0, -r * 0.45, r * ((hot ? 1.6 : 1.35) + (a + 1) * 0.09), 0, Math.PI * 2);
      ctx.fill();
      if (hot) {
        ctx.fillStyle = "rgba(255,180,60,0.22)";
        ctx.beginPath();
        ctx.arc(0, -r * 0.4, r * (1.1 + (c + 1) * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }

      const tall = hot ? 1.18 : 1;
      const outer = hot ? "#ff0000" : "#ff2d00";
      const mid = hot ? "#ff6a00" : "#ff8a1e";
      const inner = hot ? "#ffd84d" : "#ffb020";

      // three separate tongues at different heights and phases
      tongue(-r * 0.52, -r * 0.1, r * 0.36, r * (1.05 + (b + 1) * 0.3) * tall, b * r * 0.22, outer);
      tongue(r * 0.5, -r * 0.16, r * 0.34, r * (0.9 + (c + 1) * 0.3) * tall, c * r * 0.22, outer);
      tongue(-r * 0.06, -r * 0.42, r * 0.52, r * (1.5 + (a + 1) * 0.34) * tall, a * r * 0.24, outer);
      // offset so the layers never nest concentrically
      tongue(-r * 0.3, -r * 0.26, r * 0.26, r * (0.8 + (c + 1) * 0.26) * tall, c * r * 0.16, mid);
      tongue(r * 0.22, -r * 0.34, r * 0.24, r * (0.95 + (a + 1) * 0.26) * tall, a * r * 0.16, mid);
      tongue(-r * 0.02, -r * 0.5, r * 0.3, r * (0.95 + (b + 1) * 0.28) * tall, b * r * 0.18, inner);

      // the pepper itself, in front so it stays recognisable
      ctx.save();
      ctx.rotate(f.rot * 0.16);
      ctx.fillStyle = f.skin;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.12, r * 0.62, r * 1.0, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = f.flesh;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.06, r * 0.58, r * 0.95, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = hot ? "rgba(255,210,120,0.85)" : "rgba(64,0,0,0.7)";
      ctx.lineWidth = hot ? 2.6 : 2.2;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.06, r * 0.58, r * 0.95, 0.22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = hot ? "rgba(255,240,200,0.85)" : "rgba(255,205,150,0.6)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.22, -r * 0.08, r * (hot ? 0.14 : 0.11), r * 0.4, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#2f7d32";
      ctx.lineWidth = Math.max(3, r * 0.19);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, -r * 0.82);
      ctx.lineTo(0, -r * 1.2);
      ctx.stroke();
      // scorpion tail hook, the tell that this one ends the run
      if (hot) {
        ctx.strokeStyle = "#5a0000";
        ctx.lineWidth = Math.max(2.5, r * 0.15);
        ctx.beginPath();
        ctx.moveTo(r * 0.1, r * 0.9);
        ctx.quadraticCurveTo(r * 0.62, r * 1.05, r * 0.5, r * 0.55);
        ctx.stroke();
      }
      ctx.restore();

      // bright licks in front of the shoulders
      tongue(-r * 0.34, -r * 0.3, r * 0.17, r * (0.55 + (c + 1) * 0.2) * tall, c * r * 0.1, hot ? "#ffffff" : "#ffd84d");
      tongue(r * 0.3, -r * 0.4, r * 0.15, r * (0.5 + (b + 1) * 0.2) * tall, b * r * 0.1, hot ? "#fffbe0" : "#ffe9a0");
    };

    const drawPower = (f) => {
      const r = f.r;
      const pulse = 1 + Math.sin(g.elapsed * 6) * 0.07;

      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.24 * pulse, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.14, 0, Math.PI * 2);
      ctx.fill();

      if (f.power === "mango") {
        ctx.fillStyle = "#e2571f";
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.78, r * 0.95, 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffb020";
        ctx.beginPath();
        ctx.ellipse(-r * 0.14, r * 0.1, r * 0.5, r * 0.62, 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3f7d1f";
        ctx.beginPath();
        ctx.ellipse(r * 0.4, -r * 0.72, r * 0.34, r * 0.14, -0.6, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      if (f.power === "health") {
        ctx.fillStyle = "#ff5e6c";
        ctx.beginPath();
        ctx.moveTo(0, r * 0.72);
        ctx.bezierCurveTo(-r * 1.05, -r * 0.1, -r * 0.5, -r * 0.92, 0, -r * 0.34);
        ctx.bezierCurveTo(r * 0.5, -r * 0.92, r * 1.05, -r * 0.1, 0, r * 0.72);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.65)";
        ctx.beginPath();
        ctx.ellipse(-r * 0.3, -r * 0.3, r * 0.16, r * 0.1, -0.6, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      if (f.power === "shield") {
        ctx.fillStyle = "#17a9a0";
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.85);
        ctx.lineTo(r * 0.68, -r * 0.45);
        ctx.quadraticCurveTo(r * 0.68, r * 0.5, 0, r * 0.88);
        ctx.quadraticCurveTo(-r * 0.68, r * 0.5, -r * 0.68, -r * 0.45);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "#fff8e6";
        ctx.lineWidth = Math.max(2.5, r * 0.14);
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(-r * 0.26, r * 0.02);
        ctx.lineTo(-r * 0.04, r * 0.28);
        ctx.lineTo(r * 0.32, -r * 0.32);
        ctx.stroke();
        return;
      }

      // fruit bowl
      ctx.fillStyle = "#ec1163";
      ctx.beginPath();
      ctx.moveTo(-r * 0.82, -r * 0.02);
      ctx.quadraticCurveTo(-r * 0.74, r * 0.86, 0, r * 0.86);
      ctx.quadraticCurveTo(r * 0.74, r * 0.86, r * 0.82, -r * 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff8e6";
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.02, r * 0.82, r * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#7cb518";
      ctx.beginPath();
      ctx.arc(-r * 0.32, -r * 0.3, r * 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ff8a1e";
      ctx.beginPath();
      ctx.arc(r * 0.22, -r * 0.36, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawPineapple = (f) => {
      const r = f.r;
      const t = g.elapsed;
      const pulse = 1 + Math.sin(t * 9 + f.seed) * 0.09;

      // layered glow so it reads as lit from within on any sky hue
      ctx.fillStyle = "rgba(255,220,60,0.18)";
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.9 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,240,150,0.26)";
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.4 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.24 * pulse, 0, Math.PI * 2);
      ctx.stroke();

      // scalloped rind, twelve lobes like a cut slice
      const lobes = 12;
      ctx.fillStyle = f.skin;
      ctx.beginPath();
      for (let i = 0; i <= lobes * 2; i++) {
        const ang = (i / (lobes * 2)) * Math.PI * 2;
        const rad = r * (i % 2 === 0 ? 1.0 : 0.86);
        const px = Math.cos(ang) * rad;
        const py = Math.sin(ang) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      // dark rind edge, the one thing that keeps it visible once the sky
      // itself has turned yellow
      ctx.strokeStyle = "rgba(120,58,0,0.75)";
      ctx.lineWidth = Math.max(2, r * 0.1);
      ctx.lineJoin = "round";
      ctx.stroke();

      // flesh
      ctx.fillStyle = f.flesh;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff0a8";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.fill();

      // radial segments
      ctx.strokeStyle = "rgba(214,146,20,0.55)";
      ctx.lineWidth = Math.max(1.4, r * 0.07);
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2 + t * 0.6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r * 0.26, Math.sin(ang) * r * 0.26);
        ctx.lineTo(Math.cos(ang) * r * 0.68, Math.sin(ang) * r * 0.68);
        ctx.stroke();
      }

      // core
      ctx.fillStyle = "#ffd400";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.13, 0, Math.PI * 2);
      ctx.fill();

      // four-point sparkle riding on top
      const sp = 0.6 + Math.abs(Math.sin(t * 7 + f.seed)) * 0.6;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.05 * sp);
      ctx.quadraticCurveTo(r * 0.08, -r * 0.12, r * 0.62 * sp, 0);
      ctx.quadraticCurveTo(r * 0.08, r * 0.12, 0, r * 1.05 * sp);
      ctx.quadraticCurveTo(-r * 0.08, r * 0.12, -r * 0.62 * sp, 0);
      ctx.quadraticCurveTo(-r * 0.08, -r * 0.12, 0, -r * 1.05 * sp);
      ctx.closePath();
      ctx.globalAlpha = 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    const drawItem = (f) => {
      ctx.save();
      ctx.translate(f.x, f.y);
      // Round fruit tumbles. Shaped fruit only sways, since a cucumber or a
      // bunch of cherries upside down looks broken rather than playful.
      // Peppers rotate their body internally so the flames keep pointing up,
      // and power-ups stay level to stay readable.
      if (f.kind === "fruit") {
        ctx.rotate(f.shape === "round" ? f.rot : Math.sin(f.rot) * 0.32);
      }
      if (f.kind === "bonus") ctx.rotate(f.rot);
      if (f.kind === "power") drawPower(f);
      else if (f.kind === "bonus") drawPineapple(f);
      else if (f.kind === "pepper") drawPepper(f);
      else drawFruit(f);
      ctx.restore();
    };

    const drawBowl = () => {
      const { x, y, w, h } = g.bowl;

      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.beginPath();
      ctx.ellipse(x, y + h + 12, w * 0.44, h * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      // body
      ctx.fillStyle = "#5b2c8d";
      ctx.beginPath();
      ctx.moveTo(x - w / 2, y);
      ctx.quadraticCurveTo(x - w * 0.46, y + h, x, y + h);
      ctx.quadraticCurveTo(x + w * 0.46, y + h, x + w / 2, y);
      ctx.closePath();
      ctx.fill();
      // the sky cycles through violet, so the bowl needs its own edge
      ctx.strokeStyle = "rgba(255,248,230,0.92)";
      ctx.lineWidth = 3;
      ctx.stroke();

      // stripe
      ctx.fillStyle = "#ec1163";
      ctx.beginPath();
      ctx.moveTo(x - w * 0.46, y + h * 0.36);
      ctx.quadraticCurveTo(x, y + h * 0.62, x + w * 0.46, y + h * 0.36);
      ctx.lineTo(x + w * 0.42, y + h * 0.56);
      ctx.quadraticCurveTo(x, y + h * 0.82, x - w * 0.42, y + h * 0.56);
      ctx.closePath();
      ctx.fill();

      // rim
      ctx.fillStyle = "#fff8e6";
      ctx.beginPath();
      ctx.ellipse(x, y, w / 2, h * 0.19, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#17a9a0";
      ctx.beginPath();
      ctx.ellipse(x, y + h * 0.02, w * 0.41, h * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();

      // shield dome
      if (g.fx.shield > 0) {
        const fade = Math.min(1, g.fx.shield / 0.6);
        ctx.globalAlpha = 0.4 * fade;
        ctx.fillStyle = "#17a9a0";
        ctx.beginPath();
        ctx.ellipse(x, y, w * 0.56, h * 1.5, 0, Math.PI, 0);
        ctx.fill();
        ctx.globalAlpha = 0.9 * fade;
        ctx.strokeStyle = "#fff8e6";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(x, y, w * 0.56, h * 1.5, 0, Math.PI, 0);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    };

    const draw = () => {
      drawSky();
      drawPowerPattern();

      ctx.save();
      if (g.shake > 0) {
        ctx.translate((Math.random() - 0.5) * g.shake * 22, (Math.random() - 0.5) * g.shake * 14);
      }

      for (const f of g.fruits) drawItem(f);

      for (const rg of g.rings) {
        if (rg.delay > 0) continue;
        const fade = Math.max(0, rg.life / rg.max);
        ctx.globalAlpha = fade * 0.8;
        ctx.strokeStyle = rg.color;
        ctx.lineWidth = 2 + 5 * fade;
        ctx.beginPath();
        ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      for (const b of g.bits) {
        ctx.globalAlpha = Math.max(0, b.life / 0.55);
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      drawBowl();

      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      for (const p of g.pops) {
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 0.5));
        ctx.font = `800 ${p.size}px Nunito, system-ui, sans-serif`;
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(38,8,60,0.85)";
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      }
      ctx.globalAlpha = 1;

      ctx.restore();
    };

    /* ----------------------------------------------------------- loop */

    const frame = (now) => {
      const dt = Math.min((now - g.last) / 1000 || 0, 0.05);
      g.last = now;
      if (g.phase === "playing") update(dt);
      draw();
      g.raf = requestAnimationFrame(frame);
    };

    layout();
    g.last = performance.now();
    g.raf = requestAnimationFrame(frame);

    const onResize = () => layout();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    const onHide = () => {
      if (document.hidden && g.phase === "playing") {
        g.dragging = false;
        g.phase = "paused";
        setPhase("paused");
      }
    };
    document.addEventListener("visibilitychange", onHide);

    return () => {
      audioRef.current?.dispose();
      audioRef.current = null;
      cancelAnimationFrame(g.raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("visibilitychange", onHide);
      wrap.removeEventListener("pointerdown", onDown);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerup", onUp);
      wrap.removeEventListener("pointercancel", onUp);
    };
  }, []);

  /* ------------------------------------------------------------- actions */

  // Started from a real click so the AudioContext is created with a user
  // gesture in hand. Tone is imported behind the loading screen; if it fails
  // or takes too long, play begins silently rather than blocking the game.
  const boot = useCallback(async () => {
    if (audioRef.current) {
      start();
      return;
    }
    setBooting(true);

    let raw = null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        raw = new Ctx();
        if (raw.state === "suspended") raw.resume();
      }
    } catch {}

    try {
      const audio = await Promise.race([
        createAudio(raw),
        new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), 8000)),
      ]);
      audioRef.current = audio;
      audio.setMuted(muted);
      audio.startMusic();
    } catch {
      audioRef.current = null; // silent fallback, the game still plays
    }

    setBooting(false);
    start();
  }, [muted]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      audioRef.current?.setMuted(next);
      try {
        localStorage.setItem("chow-muted", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const start = useCallback(() => {
    const g = gameRef.current;
    if (!g) return;
    audioRef.current?.startMusic();
    g.fruits = [];
    g.bits = [];
    g.pops = [];
    g.rings = [];
    g.elapsed = 0;
    g.caught = 0;
    g.score = 0;
    g.lives = START_LIVES;
    g.nextDrop = 500;
    g.nextPower = 10000;
    g.nextBonus = 30000;
    g.powerOut = false;
    g.shake = 0;
    g.hudSig = "";
    g.hue = SKY_FROM;
    for (const key of TIMED_KEYS) g.fx[key] = 0;
    g.bowl.w = g.bowl.baseW;
    g.bowl.target = g.w / 2;
    g.bowl.x = g.w / 2;
    g.phase = "playing";
    setScore(0);
    setLives(START_LIVES);
    setActive([]);
    setHurt(0);
    setHeal(0);
    setBoardOpen(false);
    setHowTo(false);
    setPhase("playing");
  }, []);

  const resume = useCallback(() => {
    const g = gameRef.current;
    if (!g) return;
    g.last = performance.now();
    g.phase = "playing";
    setPhase("playing");
  }, []);

  const saveScore = useCallback(async () => {
    setSaveState("saving");
    setSaveNote("");
    const clean = name.trim().slice(0, 20);
    try {
      localStorage.setItem("chow-name", clean);
    } catch {}

    try {
      const res = await fetch("/api/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clean, score }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Save failed.");
      setSaveState("saved");
      setSaveNote(`Saved. You are number ${data.rank} on the board.`);
    } catch (error) {
      setSaveState("error");
      setSaveNote(error.message || "Could not save that score.");
    }
  }, [name, score]);

  const openBoard = useCallback(async () => {
    setBoardOpen(true);
    setBoard(null);
    try {
      const res = await fetch("/api/scores", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Leaderboard unavailable.");
      setBoard(data.scores || []);
    } catch (error) {
      setBoard([]);
      setSaveNote(error.message);
    }
  }, []);

  /* -------------------------------------------------------------- render */

  return (
    <main className="game" ref={wrapRef}>
      <canvas ref={canvasRef} className="game__canvas" />

      {hurt > 0 && <div className="flash" key={`hurt-${hurt}`} />}
      {heal > 0 && <div className="flash flash--heal" key={`heal-${heal}`} />}

      {booting && (
        <div className="veil veil--boot">
          <div className="boot">
            <div className="boot__bowl" />
            <p className="boot__text">Warming up the steel pan...</p>
          </div>
        </div>
      )}

      {phase === "playing" && (
        <button
          className="mute"
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={muted}
        >
          {muted ? "\u2715 Sound" : "\u266a Sound"}
        </button>
      )}

      <div className="hud">
        <div className="hud__chip">
          <span className="hud__cap">Score</span>
          <span className="hud__value">{score}</span>
        </div>
        <div className="hud__chip">
          <span className="hud__cap">Health</span>
          <span className="hud__lives">
            <b>{"\u2665".repeat(Math.max(0, lives))}</b>
            <i>{"\u2661".repeat(Math.max(0, START_LIVES - lives))}</i>
          </span>
        </div>
        <Link href="/" className="hud__back">
          Exit
        </Link>
      </div>

      {phase === "playing" && active.length > 0 && (
        <div className="powers">
          {active.map((p) => (
            <span
              key={p.key}
              className="power"
              style={{ color: p.color, borderColor: p.color }}
            >
              {p.label} <b className="power__time">{p.left.toFixed(1)}s</b>
              <i className="power__fill" style={{ width: `${p.pct * 100}%` }} />
            </span>
          ))}
        </div>
      )}

      {phase === "ready" && (
        <div className="veil">
          <div className="panel">
            <h1 className="panel__title">Catch the Citrus</h1>
            <p className="panel__text">
              Drag anywhere to slide the bowl. New fruit joins as your score
              climbs, and the smaller it is the more it pays.
            </p>

            <button className="btn" onClick={boot} disabled={booting}>
              {booting ? "Loading..." : "Start"}
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => setHowTo((v) => !v)}
              aria-expanded={howTo}
            >
              {howTo ? "Hide how to play" : "How to play"}
            </button>

            {howTo && (
              <div className="howto">
            <ul className="rules">
              <li className="rules__row">
                <span className="rules__dot" style={{ background: "hsl(2,78%,60%)" }} />
                Grapefruit 5
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "hsl(28,96%,55%)", width: 14, height: 14 }}
                />
                Orange 10
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "hsl(50,100%,52%)", width: 13, height: 13 }}
                />
                Lemon 15 at 150
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "hsl(102,44%,40%)", width: 9, height: 15, borderRadius: 5 }}
                />
                Cucumber 8 at 250
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "hsl(82,72%,44%)", width: 11, height: 11 }}
                />
                Lime 30 at 500
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "hsl(352,78%,48%)", width: 13, height: 12 }}
                />
                Apple 20 at 700
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "hsl(33,100%,56%)", width: 8, height: 8 }}
                />
                Kumquat 60 at 900
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "hsl(344,80%,44%)", width: 9, height: 9 }}
                />
                Cherries 80 at 1200
              </li>
            </ul>

            <ul className="rules rules--stack">
              <li>
                <b style={{ color: "#d21414" }}>Burning pepper</b> — costs a life.
              </li>
              <li>
                <b style={{ color: "#ff2424" }}>Scorpion pepper</b> — from 500, and
                catching one ends the run on the spot.
              </li>
            </ul>

            <ul className="rules rules--stack">
              <li>
                <b style={{ color: "#e0a800" }}>Pineapple slice</b> — rare, drops
                five times faster than anything else, and pays 150 if you can
                get under it.
              </li>
            </ul>

            <p className="panel__label">Power-ups</p>
            <ul className="rules rules--stack">
              <li>
                <b style={{ color: POWERS.mango.color }}>Catch all</b> — bowl spans
                the screen and peppers burn up harmlessly, but fruit falls
                faster. 9s
              </li>
              <li>
                <b style={{ color: POWERS.health.color }}>+1 Health</b> — one heart
                back. At full health it pays 100 points instead.
              </li>
              <li>
                <b style={{ color: POWERS.shield.color }}>Shield</b> — dropped fruit
                costs you nothing. 7s
              </li>
              <li>
                <b style={{ color: POWERS.bowl.color }}>Fruit bowl</b> — double the
                fruit at 40% speed, no peppers, and drops are free. 10s
              </li>
            </ul>
                          <p className="panel__text">
              Miss a power-up and nothing happens. Every power-up clears the
              screen when it ends.
            </p>
              </div>
            )}

            <button className="btn btn--ghost" onClick={toggleMute}>
              {muted ? "\u2715 Sound off" : "\u266a Sound on"}
            </button>

            {best > 0 && <p className="panel__text">Your best so far: {best}</p>}
            <Link href="/" className="btn btn--ghost">
              Back to poster
            </Link>
          </div>
        </div>
      )}

      {phase === "paused" && (
        <div className="veil">
          <div className="panel">
            <h1 className="panel__title">Paused</h1>
            <p className="panel__text">You left the game. Pick up where you stopped.</p>
            <button className="btn" onClick={resume}>
              Keep going
            </button>
            <button className="btn btn--ghost" onClick={toggleMute}>
              {muted ? "\u2715 Sound off" : "\u266a Sound on"}
            </button>
          </div>
        </div>
      )}

      {phase === "over" && (
        <div className="veil">
          <div className="panel">
            {boardOpen ? (
              <>
                <h1 className="panel__title">Top 10</h1>
                {board === null ? (
                  <p className="panel__text">Loading the board...</p>
                ) : board.length === 0 ? (
                  <p className="panel__text">
                    {saveNote || "No scores yet. Yours can be the first."}
                  </p>
                ) : (
                  <ol className="board">
                    {board.map((row, i) => (
                      <li className="board__row" key={`${row.name}-${i}`}>
                        <span className="board__rank">{i + 1}</span>
                        <span className="board__name">{row.name}</span>
                        <span className="board__score">{row.score}</span>
                      </li>
                    ))}
                  </ol>
                )}
                <button className="btn" onClick={boot}>
                  Play again
                </button>
                <button className="btn btn--ghost" onClick={() => setBoardOpen(false)}>
                  Back
                </button>
                <button className="btn btn--ghost" onClick={toggleMute}>
                  {muted ? "\u2715 Sound off" : "\u266a Sound on"}
                </button>
              </>
            ) : (
              <>
                <h1 className="panel__title">Bowl Empty</h1>
                <p className="panel__score">{score}</p>
                <p className="panel__text">
                  {score >= best && score > 0
                    ? "That is your best run yet."
                    : `Your best is ${best}.`}
                </p>

                <label className="panel__label" htmlFor="player">
                  Name for the board
                </label>
                <input
                  id="player"
                  className="field"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Who catch it?"
                  maxLength={20}
                  autoComplete="off"
                />

                <p className={`status ${saveState === "error" ? "status--bad" : "status--ok"}`}>
                  {saveNote}
                </p>

                <button
                  className="btn"
                  onClick={saveScore}
                  disabled={saveState === "saving" || saveState === "saved"}
                >
                  {saveState === "saving"
                    ? "Saving..."
                    : saveState === "saved"
                    ? "Score saved"
                    : "Save my score"}
                </button>
                <button className="btn btn--sea" onClick={boot}>
                  Play again
                </button>
                <button className="btn btn--ghost" onClick={openBoard}>
                  See the top 10
                </button>
                <button className="btn btn--ghost" onClick={toggleMute}>
                  {muted ? "\u2715 Sound off" : "\u266a Sound on"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
