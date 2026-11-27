# Releasing pntome

pntome updates itself from GitHub Releases with the Tauri updater plugin. On launch (after about 5 seconds) and from **Tài khoản → Kiểm tra cập nhật**, the app fetches

```
https://github.com/crushonublu/pinknbook/releases/latest/download/latest.json
```

If `latest.json` names a higher version, a small banner offers "Cập nhật ngay" / "Để sau". The app downloads the installer, checks its signature against the public key in `app/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), runs it in passive mode and restarts.

`releases/latest` is the newest release that is **not** a draft or a pre-release. Draft and pre-release builds are never offered to users.

## The updater signing key

The installer is signed with a minisign key made by `npx tauri signer generate`. This is separate from Windows code signing (Authenticode), which pntome does not use yet.

| File | What it is |
|---|---|
| `%USERPROFILE%\.tauri\pntome.key` | Private key (encrypted with the password). **Never commit it.** |
| `%USERPROFILE%\.tauri\pntome.key.password` | The key's password |
| `%USERPROFILE%\.tauri\pntome.key.pub` | Public key, the same as `pubkey` in `tauri.conf.json` |

**Back up the private key and its password somewhere safe** (a password manager, an encrypted drive). Installed copies only accept updates signed by this key. If the key is lost, every existing install is stuck on its version for good, and users have to download a new installer by hand. Rotating the key works the same way: only installs that already trust the new public key can follow.

`.gitignore` excludes `*.key`.

## Steps

All commands are PowerShell, run from the repo root unless noted.

1. **Bump the version** to the same `x.y.z` in all three places:
   - `app/src-tauri/tauri.conf.json` → `"version"` (this is the one the updater compares)
   - `app/src-tauri/Cargo.toml` → `[package] version`
   - `app/package.json` → `"version"`

   Commit the bump.

2. **Build with the signing key** in the environment:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\pntome.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content "$env:USERPROFILE\.tauri\pntome.key.password" -Raw).Trim()
   cd app
   npm run tauri build
   cd ..
   ```

   This writes `app/src-tauri/target/release/bundle/nsis/pntome_x.y.z_x64-setup.exe` and `pntome_x.y.z_x64-setup.exe.sig`. Without the variables the build fails at the signing step, because `bundle.createUpdaterArtifacts` is on.

3. **Write `latest.json`**, with a short changelog. The first three lines show in the update banner; Markdown bullets and headings are stripped.

   ```powershell
   node scripts/make-latest-json.mjs --notes-file notes.md
   ```

   or `--notes "- Fixed …"`. It reads the `.sig` and writes `bundle/nsis/latest.json`, with the download URL pointing at `releases/download/vx.y.z/pntome_x.y.z_x64-setup.exe`.

4. **Tag and publish** a GitHub Release named `vx.y.z` (tag `vx.y.z`, matching the URL in `latest.json`), as a normal release, not a draft or pre-release. Upload:
   - `pntome_x.y.z_x64-setup.exe`
   - `pntome_x.y.z_x64-setup.exe.sig`
   - `latest.json`

   The tag must match exactly, or the download URL in `latest.json` returns 404 and the update fails.

5. **Check it**: open an older installed version and use **Kiểm tra cập nhật**. It should offer the new version.

## Android

The Android APK is signed with a separate Java keystore, also kept outside the repo:

| File | What it is |
|---|---|
| `%USERPROFILE%\.tauri\pntome-android.jks` | Release keystore (alias `pntome`). **Never commit it.** |
| `%USERPROFILE%\.tauri\pntome-android.password` | Its password (store and key) |
| `%USERPROFILE%\.tauri\pntome-android.properties` | `storeFile`, `keyAlias`, `passwordFile`: read by `gen/android/app/build.gradle.kts` (or set `PNTOME_ANDROID_SIGNING` to another properties file) |

**Back these up with the updater key.** Android only installs an update over an existing install when it is signed by the same key; with a lost key, users must uninstall (losing app data) to install a new build. Without the properties file the release APK is built unsigned.

Build (after the version bump above; `tauri.properties` takes the version from `tauri.conf.json`):

```powershell
cd app
npm run tauri android build -- --apk
cd ..
```

The signed APK is `app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`. Upload it to the same GitHub Release as `pntome_x.y.z_android.apk`. The Android app has no in-app updater yet: users install the new APK by hand.

## Notes

- **0.1.0 has no updater.** People on 0.1.0 install 0.1.1 (the first version with the updater) by hand once; after that, updates arrive in the app.
- Windows SmartScreen may still warn about the unsigned installer on first install. Updates run the installer in passive mode (a small progress window, no questions).
- To try the banner without a release, run the frontend in dev and open `http://localhost:1420/?mockUpdate`. It fakes version 9.9.9 with a simulated download. This works only in dev builds.
- To test the real check against a local manifest, build with a config override that points the endpoint at a local server, for example:

  ```powershell
  npm run tauri build -- --no-bundle --config '{\"plugins\":{\"updater\":{\"endpoints\":[\"http://127.0.0.1:8765/latest.json\"],\"dangerousInsecureTransportProtocol\":true}}}'
  ```

  Serve a `latest.json` with a higher version from that address. Rebuild without the override before releasing.
