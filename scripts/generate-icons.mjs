import fs from "fs";
import path from "path";
import sharp from "sharp";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "public", "app-icon.png");
const OUT_DIR = path.join(ROOT, "public", "icons");

if (!fs.existsSync(SRC)) {
  console.error("❌ Bronbestand niet gevonden:", SRC);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const jobs = [
  // PWA icons
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },

  // Maskable icons (iets meer padding, zodat Android netjes rond kan masken)
  { name: "maskable-192.png", size: 192, pad: 0.12 },
  { name: "maskable-512.png", size: 512, pad: 0.12 },

  // iOS home screen
  { name: "apple-touch-icon.png", size: 180 },

  // favicons (png)
  { name: "favicon-32.png", size: 32 },
  { name: "favicon-16.png", size: 16 },
];

async function run() {
  const base = sharp(SRC).png();

  for (const j of jobs) {
    const outPath = path.join(OUT_DIR, j.name);

    if (j.pad) {
      const padPx = Math.round(j.size * j.pad);
      const inner = j.size - padPx * 2;

      const resized = await base.clone().resize(inner, inner, { fit: "contain" }).toBuffer();

      await sharp({
        create: {
          width: j.size,
          height: j.size,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }, // transparant
        },
      })
        .composite([{ input: resized, top: padPx, left: padPx }])
        .png()
        .toFile(outPath);
    } else {
      await base.clone().resize(j.size, j.size, { fit: "cover" }).toFile(outPath);
    }

    console.log("✅", j.name);
  }

  console.log("\n🎉 Klaar! Icons staan in:", OUT_DIR);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
