# Development

## Requirements

- Windows 10/11 with the WebView2 runtime.
- [Node.js](https://nodejs.org) 20 or later.
- [Rust](https://rustup.rs) stable, with the MSVC toolchain (Visual Studio Build Tools, "Desktop development with C++").

## Commands

All commands run from `app/`.

```bash
npm install
npm run tauri dev       # app with hot reload (Vite on http://localhost:1420)
npm run build           # type-check (tsc) and build the frontend
npm run tauri build     # release build and installers in src-tauri/target/release/bundle
```

Rust tests run from `app/src-tauri/`:

```bash
cargo test --lib
```

## Layout

```
app/
├─ index.html, vite.config.ts
├─ public/
│  ├─ foliate/          vendored foliate-js (book rendering), loaded at runtime from /foliate/view.js
│  └─ badges/           reading-badge artwork
├─ src/                 React UI (TypeScript)
└─ src-tauri/           Tauri backend (Rust)
docs/                   user guide, screenshots, this file
```

### Frontend (`app/src`)

| File | What it does |
|---|---|
| `App.tsx` | Title bar, sign-in, routing between library, reader, stats and vocabulary |
| `Library.tsx`, `Bookcase.tsx`, `Book3D.tsx`, `BookCover.tsx`, `spine.ts` | Library views: bookcase with status shelves and drag and drop, grid, list, generated spines and covers |
| `BookDetail.tsx`, `BookEditor.tsx` | Book details, reading status, title, author, cover and spine customization |
| `Reader.tsx` | The reader: foliate view, page turns, wheel paging, highlights, footnotes, Kindle position sync, the dictionary and X-Ray hooks |
| `ReaderSidebar.tsx`, `ReaderSettings.tsx`, `readerPrefs.ts`, `ScrubBar.tsx` | Sidebar tabs, reading settings, the progress bar |
| `curl/` | Page-curl animation (WebGL-free canvas renderer) |
| `annotate.ts`, `AnnotationPopup.tsx`, `Footnote.tsx` | Highlights, notes and footnote popups |
| `bookSearch.ts`, `SearchPanel.tsx` | Find in book, ignoring diacritics |
| `dictionary.ts`, `DictPopup.tsx`, `Vocab.tsx` | Dictionary lookup and the vocabulary notebook |
| `xrayIndex.ts` | X-Ray engine: finding names, sorting them into person, place, organisation or term, the first-person narrator, merging names into one person, and who appears with whom |
| `XRay.tsx`, `XRayGraph.tsx`, `graphLayout.ts` | X-Ray panel, relationship map (layout, label placement, relationship kinds) and AI labelling |
| `Stats.tsx` | Reading stats, streak and badges |
| `SendToKindle.tsx`, `KindlePush.tsx` | Send EPUB to Kindle; push a reading status to Kindle |
| `i18n.ts` | Every UI string, in Vietnamese and English |
| `icons.tsx` | Inline Reicon duotone icons |

### Backend (`app/src-tauri/src`)

| Module | What it does |
|---|---|
| `adp/` | Amazon device protocol: registration (OAuth PKCE then `/auth/register`), request signing, library and reading-state calls |
| `creds.rs` | Device key and token in Windows Credential Manager |
| `db.rs` | SQLite schema and helpers |
| `commands.rs` | Sign-in, library sync (with pruning), downloads, reading-position push |
| `annotations.rs`, `bookmarks.rs` | Highlights, notes, bookmarks and Kindle annotation sync |
| `library_meta.rs`, `meta.rs` | Covers and metadata pulled from book files in the background |
| `stats.rs` | Reading log, Kindle-time estimates, streak and badges |
| `stk.rs` | Send to Kindle uploads |
| `dict.rs` | Downloads Wiktionary and Open English WordNet and builds `dict/dict.sqlite`; lookup |
| `vocab.rs` | Vocabulary notebook |
| `ai.rs` | Claude and DeepSeek calls for X-Ray, cost estimates, API keys in Credential Manager, X-Ray storage |

## Notes

- **App data:** `%APPDATA%\com.pinknbook.app`. Delete it to start from scratch, after signing out so the device credentials are cleared too.
- **Strings:** add every new string to both the `vi` and `en` blocks of `i18n.ts`. `STR[lang]` is a union of the two, so using a key that one block lacks is a type error.
- **X-Ray index:** stored per book. Bump `INDEX_VERSION` in `xrayIndex.ts` whenever detection changes, so books are scanned again on next open. Reader edits (merges, names, types, labels) are keyed by name and survive a rebuild.
- **AI:** requests are built in `XRayGraph.tsx`, in small batches; prompts and schemas are in `ai.rs`. Claude uses structured output, and DeepSeek uses JSON mode with thinking turned off.
- **Secrets:** never commit device keys, tokens or captured traffic. `.gitignore` blocks the usual file names, but check `git status` before pushing.
