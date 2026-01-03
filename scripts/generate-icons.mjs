import fs from "fs";
import path from "path";
import sharp from "sharp";

const src = path.join(process.cwd(), "public", "app-icon.png");

// output root (iOS pakt root het best)
const outRoot = (name) => path.join(process.cwd(), "public", name);

async function main() {
  if (!fs.existsSync(src)) {
    throw new Error("Missing public/app-icon.png");
  }

  // Trim verwijdert transparante/lege randen → daarna COVER zodat het echt vult
  const base = sharp(src).trim();

  // iOS: apple-touch-icon MUST feel “full-bleed”
  await base
    .resize(180, 180, { fit: "cover", position: "centre" })
    .png()
    .toFile(outRoot("apple-touch-icon.png"));

  // PWA icons
  await base.resize(192, 192, { fit: "cover" }).png().toFile(outRoot("icon-192.png"));
  await base.resize(512, 512, { fit: "cover" }).png().toFile(outRoot("icon-512.png"));

  // Maskable (Android). We maken hier bewust wat padding zodat Android mooi blijft.
  // (iOS gebruikt maskable niet)
  await sharp(src)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .png()
    .toFile(outRoot("maskable-512.png"));

  await sharp(src)
    .resize(192, 192, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .png()
    .toFile(outRoot("maskable-192.png"));

  console.log("✅ Icons generated in /public");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
