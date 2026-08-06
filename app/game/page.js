"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

const CITRUS = [
  { flesh: "#7cb518", skin: "#5d8c0e", name: "lime" },
  { flesh: "#ffd500", skin: "#d9a900", name: "lemon" },
  { flesh: "#ff8a1e", skin: "#d96a00", name: "orange" },
  { flesh: "#ff5e5b", skin: "#c93a37", name: "grapefruit" },
];

const START_LIVES = 3;

export default function GamePage() {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const gameRef = useRef(null);

  const [phase, setPhase] = useState("ready"); // ready | playing | over
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(START_LIVES);
  const [best, setBest] = useState(0);

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
      bowl: { x: 0, y: 0, w: 120, h: 46, target: 0 },
      dragging: false,
      elapsed: 0,
      caught: 0,
      lives: START_LIVES,
      score: 0,
      nextDrop: 0,
      shake: 0,
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

      g.bowl.w = Math.max(94, Math.min(g.w * 0.3, 170));
      g.bowl.h = g.bowl.w * 0.4;
      g.bowl.y = g.h - g.bowl.h - Math.max(56, g.h * 0.11);
      if (!g.bowl.x) {
        g.bowl.x = g.w / 2;
        g.bowl.target = g.w / 2;
      }
      clampBowl();
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

    const spawn = () => {
      const r = Math.max(15, Math.min(g.w, 460) * 0.055);
      const pepper = g.caught >= 4 && Math.random() < 0.16;
      const kind = CITRUS[(Math.random() * CITRUS.length) | 0];
      const margin = r + 8;

      g.fruits.push({
        x: margin + Math.random() * Math.max(1, g.w - margin * 2),
        y: -r * 2,
        prevBottom: -r,
        r,
        pepper,
        flesh: pepper ? "#e02020" : kind.flesh,
        skin: pepper ? "#a51414" : kind.skin,
        spin: (Math.random() - 0.5) * 2.4,
        rot: Math.random() * Math.PI,
        vy:
          (215 + g.elapsed * 13 + g.caught * 9) *
          g.unit *
          (0.9 + Math.random() * 0.25),
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
      if (g.bits.length > 90) g.bits.splice(0, g.bits.length - 90);
    };

    /* --------------------------------------------------------- update */

    const update = (dt) => {
      g.elapsed += dt;

      // bowl follows the finger, smoothed just enough to kill jitter
      g.bowl.x += (g.bowl.target - g.bowl.x) * Math.min(1, dt * 24);

      g.nextDrop -= dt * 1000;
      if (g.nextDrop <= 0) {
        spawn();
        g.nextDrop = Math.max(330, 950 - g.elapsed * 21 - g.caught * 11);
      }

      const rimY = g.bowl.y;
      const half = g.bowl.w / 2;

      for (let i = g.fruits.length - 1; i >= 0; i--) {
        const f = g.fruits[i];
        f.prevBottom = f.y + f.r;
        f.y += f.vy * dt;
        f.rot += f.spin * dt;

        const bottom = f.y + f.r;
        const crossedRim = f.prevBottom <= rimY && bottom >= rimY;
        const overBowl = Math.abs(f.x - g.bowl.x) <= half;

        if (crossedRim && overBowl) {
          g.fruits.splice(i, 1);
          if (f.pepper) {
            g.lives -= 1;
            g.shake = 0.35;
            burst(f.x, rimY, "#e02020");
            setLives(g.lives);
            if (g.lives <= 0) end();
          } else {
            g.caught += 1;
            g.score += 10;
            burst(f.x, rimY, f.flesh);
            setScore(g.score);
          }
          continue;
        }

        if (f.y - f.r > g.h + 20) {
          g.fruits.splice(i, 1);
          if (!f.pepper) {
            g.lives -= 1;
            g.shake = 0.25;
            setLives(g.lives);
            if (g.lives <= 0) end();
          }
        }
      }

      for (let i = g.bits.length - 1; i >= 0; i--) {
        const b = g.bits[i];
        b.life -= dt;
        if (b.life <= 0) {
          g.bits.splice(i, 1);
          continue;
        }
        b.vy += 900 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      }

      if (g.shake > 0) g.shake = Math.max(0, g.shake - dt);
    };

    const end = () => {
      g.phase = "over";
      g.dragging = false;
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

    const drawFruit = (f) => {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot * 0.25);

      if (f.pepper) {
        ctx.fillStyle = f.flesh;
        ctx.beginPath();
        ctx.ellipse(0, 0, f.r * 0.58, f.r * 1.0, 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#2f7d32";
        ctx.lineWidth = Math.max(3, f.r * 0.2);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-f.r * 0.3, -f.r * 0.85);
        ctx.lineTo(-f.r * 0.05, -f.r * 1.3);
        ctx.stroke();
        ctx.restore();
        return;
      }

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
      ctx.restore();
    };

    const draw = () => {
      ctx.clearRect(0, 0, g.w, g.h);
      ctx.save();
      if (g.shake > 0) {
        ctx.translate((Math.random() - 0.5) * g.shake * 22, (Math.random() - 0.5) * g.shake * 14);
      }

      for (const f of g.fruits) drawFruit(f);

      for (const b of g.bits) {
        ctx.globalAlpha = Math.max(0, b.life / 0.55);
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      drawBowl();
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
    g.elapsed = 0;
    g.caught = 0;
    g.score = 0;
    g.lives = START_LIVES;
    g.nextDrop = 500;
    g.shake = 0;
    g.bowl.target = g.w / 2;
    g.bowl.x = g.w / 2;
    g.phase = "playing";
    setScore(0);
    setLives(START_LIVES);
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

      <div className="hud">
        <div className="hud__chip">
          Score <span className="hud__value">{score}</span>
        </div>
        <div className="hud__chip">
          <span className="hud__lives">
            {"●".repeat(Math.max(0, lives))}
            {"○".repeat(Math.max(0, START_LIVES - lives))}
          </span>
        </div>
        <Link href="/" className="hud__back">
          Exit
        </Link>
      </div>

      {phase === "ready" && (
        <div className="veil">
          <div className="panel">
            <h1 className="panel__title">Catch the Citrus</h1>
            <p className="panel__text">
              Drag anywhere to slide the bowl. Every catch is 10 points, and the
              fruit keeps coming faster.
            </p>
            <div className="legend">
              <span className="legend__item">
                <span className="legend__dot" style={{ background: "#7cb518" }} />
                Catch
              </span>
              <span className="legend__item">
                <span className="legend__dot" style={{ background: "#e02020" }} />
                Pepper costs a life
              </span>
            </div>
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
