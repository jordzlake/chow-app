"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

/* Smaller fruit is worth more. `unlock` is how many catches it takes before
   that size joins the mix, so the drop pool gets finer as the run goes on. */
const FRUITS = [
  { key: "grapefruit", scale: 1.3, points: 5, flesh: "#ff5e5b", skin: "#c93a37", unlock: 0, weight: 2 },
  { key: "orange", scale: 1.0, points: 10, flesh: "#ff8a1e", skin: "#d96a00", unlock: 0, weight: 4 },
  { key: "lemon", scale: 0.86, points: 15, flesh: "#ffd500", skin: "#d9a900", unlock: 6, weight: 3 },
  { key: "lime", scale: 0.66, points: 30, flesh: "#7cb518", skin: "#5d8c0e", unlock: 14, weight: 3 },
  { key: "kumquat", scale: 0.46, points: 60, flesh: "#ffa41e", skin: "#d97a00", unlock: 26, weight: 2 },
];

const POWERS = {
  mango: { label: "Catch all", seconds: 5, color: "#ff8a1e" },
  speed: { label: "Quick hands", seconds: 5, color: "#ffd500" },
  shield: { label: "Shield", seconds: 3, color: "#17a9a0" },
  bowl: { label: "Fruit bowl", seconds: 6, color: "#ec1163" },
};

const POWER_KEYS = Object.keys(POWERS);
const START_LIVES = 3;

export default function GamePage() {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const gameRef = useRef(null);

  const [phase, setPhase] = useState("ready"); // ready | playing | paused | over
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(START_LIVES);
  const [best, setBest] = useState(0);
  const [active, setActive] = useState([]); // live power-up timers for the HUD
  const [hurt, setHurt] = useState(0); // timestamp of the last hit, keys the flash

  const [name, setName] = useState("");
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [saveNote, setSaveNote] = useState("");
  const [board, setBoard] = useState(null);
  const [boardOpen, setBoardOpen] = useState(false);

  useEffect(() => {
    try {
      setName(localStorage.getItem("chow-name") || "");
      setBest(Number(localStorage.getItem("chow-best") || 0));
    } catch {}
  }, []);

  /* ------------------------------------------------------------ engine */

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext("2d", { alpha: true });

    const g = {
      w: 0,
      h: 0,
      unit: 1,
      phase: "ready",
      fruits: [],
      bits: [],
      pops: [],
      bowl: { x: 0, y: 0, w: 120, baseW: 120, h: 46, target: 0 },
      fx: { mango: 0, speed: 0, shield: 0, bowl: 0 },
      dragging: false,
      elapsed: 0,
      caught: 0,
      lives: START_LIVES,
      score: 0,
      nextDrop: 0,
      nextPower: 0,
      powerOut: false,
      shake: 0,
      hudTick: 0,
      hudSig: "",
      raf: 0,
      last: 0,
    };
    gameRef.current = g;

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

    const fallSpeed = () =>
      (215 + g.elapsed * 13 + g.caught * 9) * g.unit * (0.9 + Math.random() * 0.25);

    const pickFruit = () => {
      const pool = FRUITS.filter((f) => g.caught >= f.unlock);
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
      const pepper = g.caught >= 4 && Math.random() < 0.16;
      const kind = pepper ? null : pickFruit();
      const r = baseRadius() * (pepper ? 1 : kind.scale);

      g.fruits.push({
        kind: pepper ? "pepper" : "fruit",
        x: place(r),
        y: -r * 2,
        prevBottom: -r,
        r,
        points: pepper ? 0 : kind.points,
        flesh: pepper ? "#e02020" : kind.flesh,
        skin: pepper ? "#a51414" : kind.skin,
        spin: (Math.random() - 0.5) * 2.4,
        rot: Math.random() * Math.PI,
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
        vy: fallSpeed() * 0.62, // drifts down slower so it stays winnable
      });
      g.powerOut = true;
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
      if (g.bits.length > 90) g.bits.splice(0, g.bits.length - 90);
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
      if (g.fx.shield > 0) {
        burst(x, y, POWERS.shield.color);
        pop(x, y, "Blocked", POWERS.shield.color, 16);
        return;
      }
      g.lives -= 1;
      g.shake = 0.3;
      setLives(g.lives);
      setHurt(performance.now()); // restarts the red edge flash
      if (g.lives <= 0) end();
    };

    const update = (dt) => {
      g.elapsed += dt;

      for (const key of POWER_KEYS) {
        if (g.fx[key] > 0) g.fx[key] = Math.max(0, g.fx[key] - dt);
      }

      // bowl width eases toward its target so Catch all reads as a sweep
      const wantW = g.fx.mango > 0 ? g.w : g.bowl.baseW;
      g.bowl.w += (wantW - g.bowl.w) * Math.min(1, dt * 12);
      if (Math.abs(wantW - g.bowl.w) < 0.5) g.bowl.w = wantW;

      // bowl follows the finger, smoothed just enough to kill jitter
      const follow = g.fx.speed > 0 ? 46 : 24;
      g.bowl.x += (g.bowl.target - g.bowl.x) * Math.min(1, dt * follow);
      clampBowl();

      g.nextDrop -= dt * 1000;
      if (g.nextDrop <= 0) {
        spawnFruit();
        if (g.fx.bowl > 0) spawnFruit(); // Fruit bowl doubles the drop
        g.nextDrop = Math.max(330, 950 - g.elapsed * 21 - g.caught * 11);
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

        // embers trail off a burning pepper
        if (f.kind === "pepper" && Math.random() < dt * 14) {
          g.bits.push({
            x: f.x + (Math.random() - 0.5) * f.r,
            y: f.y - f.r * 0.9,
            vx: (Math.random() - 0.5) * 40,
            vy: -30 - Math.random() * 50,
            life: 0.45,
            rise: true,
            color: Math.random() < 0.5 ? "#ffd84d" : "#ff8a1e",
            r: 1.5 + Math.random() * 2,
          });
        }

        if (crossedRim && overBowl) {
          g.fruits.splice(i, 1);

          if (f.kind === "power") {
            g.powerOut = false;
            const spec = POWERS[f.power];
            g.fx[f.power] = spec.seconds; // refreshes rather than stacks
            burst(f.x, rimY, spec.color);
            pop(f.x, rimY - 14, spec.label, spec.color, 19);
          } else if (f.kind === "pepper") {
            if (g.fx.mango > 0) {
              // Catch all is a fire of its own; peppers burn up harmlessly.
              burst(f.x, rimY, "#ffb020");
              pop(f.x, rimY - 12, "Burned up", "#ffd84d", 17);
            } else {
              burst(f.x, rimY, "#e02020");
              loseLife(f.x, rimY);
            }
          } else {
            g.caught += 1;
            g.score += f.points;
            burst(f.x, rimY, f.flesh);
            pop(f.x, rimY - 10, `+${f.points}`, "#fff8e6", f.points >= 30 ? 22 : 17);
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
        const live = POWER_KEYS.filter((k) => g.fx[k] > 0).map((k) => ({
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
      g.phase = "over";
      g.dragging = false;
      for (const key of POWER_KEYS) g.fx[key] = 0;
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

    const drawCitrus = (f) => {
      ctx.fillStyle = f.skin;
      ctx.beginPath();
      ctx.arc(0, f.r * 0.08, f.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = f.flesh;
      ctx.beginPath();
      ctx.arc(0, 0, f.r * 0.94, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.ellipse(-f.r * 0.32, -f.r * 0.38, f.r * 0.26, f.r * 0.17, -0.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#3f7d1f";
      ctx.beginPath();
      ctx.ellipse(f.r * 0.42, -f.r * 0.72, f.r * 0.3, f.r * 0.15, -0.7, 0, Math.PI * 2);
      ctx.fill();
    };

    // A rounded, curling flame. `sway` bends the tip so each one flickers on
    // its own phase instead of the whole fire pulsing as a single shape.
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
      ctx.quadraticCurveTo(x, baseY + h * 0.14, x - w, baseY);
      ctx.closePath();
      ctx.fill();
    };

    const drawPepper = (f) => {
      const r = f.r;
      const t = g.elapsed;
      const a = Math.sin(t * 13 + f.seed);
      const b = Math.sin(t * 9.3 + f.seed * 2.4 + 1.1);
      const c = Math.sin(t * 17 + f.seed * 1.7 + 2.2);

      // heat halo, dark enough to hold up on both the yellow sky and teal ground
      ctx.fillStyle = "rgba(200,25,0,0.15)";
      ctx.beginPath();
      ctx.arc(0, -r * 0.45, r * (1.35 + (a + 1) * 0.07), 0, Math.PI * 2);
      ctx.fill();

      // three separate red tongues at different heights and phases
      tongue(-r * 0.52, -r * 0.1, r * 0.36, r * (1.05 + (b + 1) * 0.3), b * r * 0.22, "#ff2d00");
      tongue(r * 0.5, -r * 0.16, r * 0.34, r * (0.9 + (c + 1) * 0.3), c * r * 0.22, "#ff2d00");
      tongue(-r * 0.06, -r * 0.42, r * 0.52, r * (1.5 + (a + 1) * 0.34), a * r * 0.24, "#ff2d00");
      // orange layer, offset so it never nests concentrically inside the red
      tongue(-r * 0.3, -r * 0.26, r * 0.26, r * (0.8 + (c + 1) * 0.26), c * r * 0.16, "#ff8a1e");
      tongue(r * 0.22, -r * 0.34, r * 0.24, r * (0.95 + (a + 1) * 0.26), a * r * 0.16, "#ff8a1e");
      tongue(-r * 0.02, -r * 0.5, r * 0.3, r * (0.95 + (b + 1) * 0.28), b * r * 0.18, "#ffb020");

      // the pepper itself, in front so it stays recognisable
      ctx.save();
      ctx.rotate(f.rot * 0.16);
      ctx.fillStyle = "#7a0b0b";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.12, r * 0.62, r * 1.0, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#d21414";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.06, r * 0.58, r * 0.95, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(64,0,0,0.7)";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.06, r * 0.58, r * 0.95, 0.22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,205,150,0.6)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.22, -r * 0.08, r * 0.11, r * 0.4, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#2f7d32";
      ctx.lineWidth = Math.max(3, r * 0.19);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, -r * 0.82);
      ctx.lineTo(0, -r * 1.2);
      ctx.stroke();
      ctx.restore();

      // bright licks in front of the shoulders
      tongue(-r * 0.34, -r * 0.3, r * 0.17, r * (0.55 + (c + 1) * 0.2), c * r * 0.1, "#ffd84d");
      tongue(r * 0.3, -r * 0.4, r * 0.15, r * (0.5 + (b + 1) * 0.2), b * r * 0.1, "#ffe9a0");
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

      if (f.power === "speed") {
        ctx.fillStyle = "#ffd500";
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#5b2c8d";
        ctx.beginPath();
        ctx.moveTo(r * 0.12, -r * 0.62);
        ctx.lineTo(-r * 0.34, r * 0.1);
        ctx.lineTo(-r * 0.02, r * 0.1);
        ctx.lineTo(-r * 0.16, r * 0.66);
        ctx.lineTo(r * 0.36, -r * 0.12);
        ctx.lineTo(r * 0.02, -r * 0.12);
        ctx.closePath();
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

    const drawItem = (f) => {
      ctx.save();
      ctx.translate(f.x, f.y);
      // Only round fruit tumbles. Peppers rotate their body internally so the
      // flames keep pointing up, and power-ups stay level to stay readable.
      if (f.kind === "fruit") ctx.rotate(f.rot * 0.25);
      if (f.kind === "power") drawPower(f);
      else if (f.kind === "pepper") drawPepper(f);
      else drawCitrus(f);
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
      ctx.clearRect(0, 0, g.w, g.h);
      ctx.save();
      if (g.shake > 0) {
        ctx.translate((Math.random() - 0.5) * g.shake * 22, (Math.random() - 0.5) * g.shake * 14);
      }

      for (const f of g.fruits) drawItem(f);

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

  const start = useCallback(() => {
    const g = gameRef.current;
    if (!g) return;
    g.fruits = [];
    g.bits = [];
    g.pops = [];
    g.elapsed = 0;
    g.caught = 0;
    g.score = 0;
    g.lives = START_LIVES;
    g.nextDrop = 500;
    g.nextPower = 10000;
    g.powerOut = false;
    g.shake = 0;
    g.hudSig = "";
    for (const key of POWER_KEYS) g.fx[key] = 0;
    g.bowl.w = g.bowl.baseW;
    g.bowl.target = g.w / 2;
    g.bowl.x = g.w / 2;
    g.phase = "playing";
    setScore(0);
    setLives(START_LIVES);
    setActive([]);
    setHurt(0);
    setBoardOpen(false);
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

      {hurt > 0 && <div className="flash" key={hurt} />}

      <div className="hud">
        <div className="hud__chip">
          <span className="hud__cap">Score</span>
          <span className="hud__value">{score}</span>
        </div>
        <div className="hud__chip">
          <span className="hud__cap">Health</span>
          <span className="hud__lives">
            <b>{"♥".repeat(Math.max(0, lives))}</b>
            <i>{"♡".repeat(Math.max(0, START_LIVES - lives))}</i>
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
              Drag anywhere to slide the bowl. The fruit gets smaller and faster
              as you go, and small fruit pays the most.
            </p>

            <ul className="rules">
              <li className="rules__row">
                <span className="rules__dot" style={{ background: "#ff5e5b" }} />
                Grapefruit 5
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "#ff8a1e", width: 13, height: 13 }}
                />
                Orange 10
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "#7cb518", width: 10, height: 10 }}
                />
                Lime 30
              </li>
              <li className="rules__row">
                <span
                  className="rules__dot"
                  style={{ background: "#ffa41e", width: 8, height: 8 }}
                />
                Kumquat 60
              </li>
              <li className="rules__row">
                <span className="rules__dot" style={{ background: "#d81414" }} />
                Burning pepper costs a life
              </li>
            </ul>

            <p className="panel__label">Power-ups</p>
            <ul className="rules rules--stack">
              <li>
                <b style={{ color: POWERS.mango.color }}>Catch all</b> — bowl spans
                the screen and peppers burn up harmlessly, but fruit falls
                faster. 5s
              </li>
              <li>
                <b style={{ color: POWERS.speed.color }}>Quick hands</b> — the bowl
                tracks your finger faster. 5s
              </li>
              <li>
                <b style={{ color: POWERS.shield.color }}>Shield</b> — drops cost
                you nothing. 3s
              </li>
              <li>
                <b style={{ color: POWERS.bowl.color }}>Fruit bowl</b> — double the
                fruit at 40% speed. 6s
              </li>
            </ul>
            <p className="panel__text">Miss a power-up and nothing happens.</p>

            <button className="btn" onClick={start}>
              Start
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
                <button className="btn" onClick={start}>
                  Play again
                </button>
                <button className="btn btn--ghost" onClick={() => setBoardOpen(false)}>
                  Back
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
                <button className="btn btn--sea" onClick={start}>
                  Play again
                </button>
                <button className="btn btn--ghost" onClick={openBoard}>
                  See the top 10
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
