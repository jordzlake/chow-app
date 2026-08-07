# Chow Master

A Next.js app: your poster fills the screen, and one button drops into a
bowl-catching game whose scores are stored in MongoDB.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000

## The only thing to change

`.env.local` holds the connection string:

```
MONGODB_URI=mongodb+srv://admin:admin123@cluster0.ykht3dw.mongodb.net/?appName=Cluster0
MONGODB_DB=chow
MONGODB_SCORES_COLLECTION=scores
```

Swap in your own and you are done. The database and collection are created on
the first saved score. In Atlas, allow your IP (or `0.0.0.0/0` for a deployed
app) under Network Access. When deploying, set `MONGODB_URI` in your host's
environment variables.

Commit `package-lock.json` alongside `package.json`. Vercel installs from the
lockfile, so a stale one is why a build would fail with `Can't resolve 'tone'`.

## Files

```
app/page.js              poster + play button
app/game/page.js         the whole game: canvas, loop, drawing, UI
app/game/audio.js        audio engine (Tone.js)
app/api/scores/route.js  GET top 10, POST a score
app/globals.css          all styling
app/layout.js            fonts and viewport
lib/mongodb.js           cached Mongo client
public/background.png    the poster
public/logo.png          Chow Master logo
```

## The game

Drag anywhere to slide the bowl.

**Fruit** unlocks by score, and smaller pays more: grapefruit 5 and orange 10
from the start, lemon 15 at 150, cucumber 8 at 250, lime 30 at 500, apple 20 at
700, kumquat 60 at 900, cherries 80 at 1200, then one Trinidad chow fruit every
250 from 1500 — green mango 90, pommecythere 110, pommerac 130, five finger 150,
guava 175, tamarind 200, chenette 240.

**Peppers** cost a life. Scorpion peppers appear from 500 and end the run
outright, unless the Shield stops one or Catch all burns it.

**Power-ups**, roughly one every 12–19s, one on screen at a time:

| | Effect |
|---|---|
| Catch all | Bowl spans the screen, peppers burn up (+5, +10 for scorpion), fruit falls faster. 9s |
| +1 Health | One heart back, up to three. At full health it pays 100 instead. |
| Shield | Nothing costs a life. Blocking a pepper pays 25, a scorpion 50. 7s |
| Fruit bowl | Double the fruit at 40% speed, no peppers, drops are free. 10s |

Every power-up clears the screen when it ends.

**Fork** — rarer than a power-up, max two. Sits beside the bowl and spears the
fruit furthest away every 7 seconds, at any height. Never widens the hit box.
A pepper that lands knocks one off.

**Pineapple slice** — rare, falls five times faster than anything else, 150.

The sky starts blue and shifts hue every 50 points, reaching yellow at 1500.

## Audio

Everything is synthesised with Tone.js: no audio files, nothing to 404.

The module is fetched at the first idle moment, and the AudioContext is created
on the first touch — inside the handler, before any await, since that is what
carries the user gesture. Both happen on the game route, so audio works whether
you arrive from the poster or open `/game` directly.

Deliberately absent, each having caused an audible problem here: convolution
reverb (most expensive node, and it blocks startup rendering an impulse
response), every noise source including percussion (reads as buzz on small
speakers), and any compressor or limiter (they modulate gain on a bus shared by
music and effects).

Sound effects sit above ~300 Hz where phone speakers can reproduce them. Catches
walk up a C major pentatonic scale and reset on a miss. The bed is bossa nova,
with tempo, filter and harmony changing per power-up but never loudness.

## Notes on weight

Fruit, bowl, peppers and forks are all drawn with canvas paths, so the game
ships no sprite assets. The poster and logo are the only images, both served as
resized WebP by `next/image`.
