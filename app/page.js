import Image from "next/image";
import Link from "next/link";
import poster from "@/public/background.png";

export default function Home() {
  return (
    <main className="poster">
      <Image
        src={poster}
        alt="Thank you for purchasing our chow. Made with love in Trinidad."
        fill
        priority
        sizes="100vw"
        placeholder="blur"
        className="poster__image"
      />

      <div className="poster__scrim" />

      <div className="poster__cta">
        <p className="poster__eyebrow">While you eat...</p>
        <Link href="/game" className="play">
          <span className="play__pip">▶</span> Catch the Citrus
        </Link>
        <p className="poster__note">Drag the bowl. Don&apos;t drop a thing.</p>
      </div>
    </main>
  );
}
