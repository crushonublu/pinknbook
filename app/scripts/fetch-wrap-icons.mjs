// Run from app/: node scripts/fetch-wrap-icons.mjs [--force]
//
// Downloads the 3D icons listed in src/wrap/icons.json (3dicons.reicon.dev, only
// those, never the whole set) into a cache folder, node_modules/.cache/wrap-icons
// (the source PNGs, kept between runs).
//
// Then it writes each as a WebP at 256px and 512px into public/wrap-icons/256 and
// public/wrap-icons/512. That conversion needs `sharp`, a dev tool that is not a
// dependency of the app: without it the script stops after the download and says
// so (`npm i -D sharp` once, then run it again). Files already converted are
// kept unless --force is given.
import fs from 'node:fs/promises';
import path from 'node:path';

const MANIFEST = 'src/wrap/icons.json';
const CACHE = 'node_modules/.cache/wrap-icons';
const OUT = 'public/wrap-icons';
const SIZES = [256, 512];
const HOST = 'cdn.3dicons.reicon.dev';
const force = process.argv.includes('--force');

const icons = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
const ids = new Set();
for (const icon of icons) {
  if (ids.has(icon.id)) throw new Error(`duplicate icon id: ${icon.id}`);
  ids.add(icon.id);
  if (new URL(icon.source_url).hostname !== HOST) throw new Error(`${icon.id}: unexpected source ${icon.source_url}`);
}

const exists = (file) => fs.stat(file).then(() => true, () => false);

// 1. The source PNGs.
await fs.mkdir(CACHE, { recursive: true });
let downloaded = 0;
for (const icon of icons) {
  const source = path.join(CACHE, `${icon.id}.png`);
  if (!force && (await exists(source))) continue;
  const res = await fetch(icon.source_url);
  if (!res.ok) throw new Error(`${icon.id}: ${res.status} ${icon.source_url}`);
  await fs.writeFile(source, Buffer.from(await res.arrayBuffer()));
  downloaded++;
  console.log(`${icon.id}: ${icon.source_url}`);
}
console.log(`${icons.length} icons in the manifest, ${downloaded} downloaded to ${CACHE}`);

// 2. The WebP files, when sharp is there.
let sharp;
try {
  ({ default: sharp } = await import('sharp'));
} catch {
  console.error(`\nThe PNGs are in ${CACHE}, but they are not converted: converting to WebP needs sharp.\nRun \`npm i -D sharp\` in app/ and run this script again.`);
  process.exit(1);
}
for (const size of SIZES) await fs.mkdir(path.join(OUT, String(size)), { recursive: true });
let written = 0;
for (const icon of icons) {
  const png = await fs.readFile(path.join(CACHE, `${icon.id}.png`));
  for (const size of SIZES) {
    const target = path.join(OUT, String(size), icon.file);
    if (!force && (await exists(target))) continue;
    // The sources are square with transparent corners: scale, keep the alpha.
    await sharp(png).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 82, alphaQuality: 100 }).toFile(target);
    written++;
  }
}
console.log(`${written} WebP files written to ${OUT}`);
