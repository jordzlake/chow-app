# Thank You for Purchasing Our Chow

A two-page Next.js app: your poster fills the screen, and one button drops into
a bowl-catching game whose scores are stored in MongoDB.

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

Swap in your own string and you are done. The database and collection are
created on the first saved score, so there is nothing to set up in Atlas beyond
allowing your IP (or `0.0.0.0/0` for a deployed app) under Network Access.

The string is also hardcoded as a fallback in `lib/mongodb.js`, so the app runs
even without an env file. When you deploy, set `MONGODB_URI` in your host's
environment variables instead.

## Deploy

Push to GitHub, import into Vercel, add `MONGODB_URI` as an environment
variable. Nothing else needs configuring.

## How the game works

- Drag anywhere on the screen to slide the bowl. Pointer events cover touch,
  mouse, and stylus.
- Each caught fruit is 10 points. Fall speed and spawn rate both climb with
  time elapsed and fruit caught, so it tightens steadily.
- Peppers appear after four catches. Catching one costs a life; letting one
  drop is free.
- Three lives. A dropped fruit costs one.
- On game over you can save your score and view the top 10.

## Files

```
app/page.js            poster + play button
app/game/page.js       canvas game, all of it
app/api/scores/route.js  GET top 10, POST a score
lib/mongodb.js         cached client, connection string lives here
public/background.png  your poster
```

## Notes on weight

Fruit and bowl are drawn with canvas paths, so the game ships no image assets.
The poster is the only asset, and `next/image` serves resized WebP versions
(around 500 KB at phone widths instead of the 2 MB source) with a blur
placeholder while it loads. Total first load for the game route is about 110 KB
of JavaScript.

The canvas is sized to `devicePixelRatio` (capped at 2) and relaid out on
resize and orientation change, so it fills any phone screen sharply. The game
pauses if you switch tabs.
