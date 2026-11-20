#!/usr/bin/env node
// Writes the updater manifest (latest.json) for a Windows release, next to the
// NSIS installer that `npm run tauri build` just signed.
//
//   node scripts/make-latest-json.mjs [--notes "text" | --notes-file notes.md] [--version x.y.z]
//
// The version defaults to app/src-tauri/tauri.conf.json. Upload the printed
// files to the GitHub Release tagged v<version>; see docs/release.md.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "crushonublu/pinknbook";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "app/src-tauri/tauri.conf.json"), "utf8"));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};

const version = opt("--version") ?? conf.version;
const notesFile = opt("--notes-file");
const notes = notesFile ? readFileSync(notesFile, "utf8").trim() : (opt("--notes") ?? "");

const product = conf.productName;
const exe = `${product}_${version}_x64-setup.exe`;
const dir = join(root, "app/src-tauri/target/release/bundle/nsis");
const sigPath = join(dir, `${exe}.sig`);
if (!existsSync(sigPath)) {
  console.error(`No signature at ${sigPath}.`);
  console.error("Build with TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD set (docs/release.md).");
  process.exit(1);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${exe}`,
    },
  },
};

const out = join(dir, "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${out}\n\nUpload to the v${version} release:\n  ${join(dir, exe)}\n  ${sigPath}\n  ${out}`);
