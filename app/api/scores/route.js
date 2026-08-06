import { NextResponse } from "next/server";
import { getScoresCollection } from "@/lib/mongodb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/scores -> top 10 scores
export async function GET() {
  try {
    const scores = await getScoresCollection();
    const top = await scores
      .find({}, { projection: { _id: 0, name: 1, score: 1, createdAt: 1 } })
      .sort({ score: -1, createdAt: 1 })
      .limit(10)
      .toArray();

    return NextResponse.json({ scores: top });
  } catch (error) {
    console.error("Leaderboard read failed:", error);
    return NextResponse.json(
      { error: "Could not reach the leaderboard. Check your connection string." },
      { status: 503 }
    );
  }
}

// POST /api/scores { name, score } -> saves one run
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  const rawName = typeof body?.name === "string" ? body.name.trim() : "";
  const name = (rawName || "Chow Lover").slice(0, 20);
  const score = Number(body?.score);

  if (!Number.isFinite(score) || score < 0 || score > 100000) {
    return NextResponse.json({ error: "Score is out of range." }, { status: 400 });
  }

  try {
    const scores = await getScoresCollection();
    await scores.insertOne({
      name,
      score: Math.round(score),
      createdAt: new Date(),
    });

    const rank =
      (await scores.countDocuments({ score: { $gt: Math.round(score) } })) + 1;

    return NextResponse.json({ saved: true, name, score: Math.round(score), rank });
  } catch (error) {
    console.error("Score save failed:", error);
    return NextResponse.json(
      { error: "Could not save that score. Check your connection string." },
      { status: 503 }
    );
  }
}
