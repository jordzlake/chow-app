import { MongoClient } from "mongodb";

// The connection string comes from .env.local. The fallback below is the one you
// supplied, so the app runs even before you set up an environment file.
const uri =
  process.env.MONGODB_URI ||
  "mongodb+srv://admin:admin123@cluster0.ykht3dw.mongodb.net/?appName=Cluster0";

const dbName = process.env.MONGODB_DB || "chow";
const collectionName = process.env.MONGODB_SCORES_COLLECTION || "scores";

const options = {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 8000,
};

// Reuse one client across hot reloads in dev and across warm serverless
// invocations in production, otherwise every request opens a new pool.
let clientPromise;

if (process.env.NODE_ENV === "development") {
  if (!global._chowMongoClientPromise) {
    global._chowMongoClientPromise = new MongoClient(uri, options).connect();
  }
  clientPromise = global._chowMongoClientPromise;
} else {
  clientPromise = new MongoClient(uri, options).connect();
}

export async function getScoresCollection() {
  const client = await clientPromise;
  const collection = client.db(dbName).collection(collectionName);

  // Cheap and idempotent: keeps leaderboard reads fast as the collection grows.
  if (!global._chowScoresIndexed) {
    global._chowScoresIndexed = true;
    collection.createIndex({ score: -1, createdAt: 1 }).catch(() => {});
  }

  return collection;
}

export default clientPromise;
