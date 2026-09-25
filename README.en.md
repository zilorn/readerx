<p align="center">
  <img src="./public/favicon.svg" alt="ReaderX" width="96" height="96" />
</p>

<p align="center">
  <a href="https://github.com/zilorn/readerx/releases/latest"><img src="https://img.shields.io/github/v/release/zilorn/readerx?label=release&color=4f8ef7&logo=github" alt="Release" /></a>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/SolidJS-1.9-2C4F7C?logo=solid&logoColor=white" alt="SolidJS" />
  <img src="https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/platform-Android%20%7C%20Linux%20%7C%20Windows-3DDC84?logo=android&logoColor=white" alt="Platform" />
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/zilorn/readerx?label=license&color=blue" alt="License" /></a>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> | <b>English</b>
</p>

# ReaderX

An ebook reader built with **Tauri 2 + SolidJS + TypeScript**: a one-handed mobile app on
Android, a side-navigation window app on desktop (Linux / Windows) — both share the same set
of pages and the same local library.

## Features

- **Bookshelf** `/`: local book grid, continue reading, reading progress, book deletion
- **Discover** `/discover`: book-source search / category discovery; add a matched book to the
  shelf and read it online
- **Book sources**: a dedicated management page (create / edit / enable / disable / delete,
  JSON import & export, per-capability switches). Book sources are written in JS and run
  sandboxed in the embedded Rust **Boa engine**, with support for async rules; how many sources
  run concurrently for one search is a global user setting (Settings → Book Sources → Source
  concurrency); online reading prefetches and caches a window of "current chapter ±5", the
  reading view only loads "current chapter ±1", and chapter text can also be batch-downloaded
  for offline reading (optionally only chapters x–y)
- **Import**: the `+` button on the bookshelf / the empty-state button picks a TXT / EPUB / PDF
  file directly, parses it and adds it to the shelf right away, without navigating away
- **Settings** `/settings`: light / dark / sepia themes, body font size, UI language
  (follow system / Simplified Chinese / English); chapter-splitting rules live on their own
  subpage
- **Reading** `/book/:id`: chapter reading, previous / next chapter, table-of-contents drawer,
  reading progress synced across pages; on a wide desktop window the text is laid out as two
  side-by-side pages (one page on phones and narrow windows; the column width adapts to the
  available width)
- **Text-to-speech**: tap the headphone icon on the reading page to listen. Two engines:
  **native speech** (Android system TTS, the default) and a **custom HTTP source** (your own TTS
  endpoint returning audio bytes). A floating ball controls pause / previous sentence / next
  sentence, with adjustable speed (1x–3x), voice, and sleep timer; the sentence being read is
  highlighted in orange in the text in real time (the chapter title is read first), and reading
  continues across chapters

On TXT import, chapter-title matching tries the "chapter-splitting rules" in order; when nothing
matches, the text is split into roughly 3000-character chapters. Built-in rules cover Chinese
chapters, prologue / preface / epilogue, `Chapter` and more, and custom regexes can be added on
the chapter-rules page.

PDF import reads the text layer first and reconstructs paragraphs (headers / footers are removed
when they repeat across pages _and_ sit outside the text block); chapters follow the PDF's own
bookmarks and fall back to splitting by character count when there are no usable bookmarks.
Scanned pages without a text layer (plus covers / facsimile inserts) are rendered whole-page as
images: the images are written to the app data directory and the book JSON only keeps references.

## Book Sources (Online Discovery & Reading)

Entry point: **Settings → Book Source Management** (or the top-right corner of the Discover page).

After you **add, import, enable/disable or save an edit** on the management page, changes take
effect **immediately, with no app restart**: the source tabs on the Discover page and search /
category discovery reflect the latest source list and enable / capability switch states at once.

- **A book source = a JS rule set**: it defines entry functions such as
  `searchBook / discoverBooks / discoverCategories / bookDetail / bookToc / bookContent`, running
  in the sandboxed **Boa engine** embedded in Rust; `async/await` is supported.
  "Source concurrency" (Settings → Book Sources) is a global user setting that controls how many
  sources run at once for a single search.
  The host APIs available to rules (`http` / `html` / `util` / `base64` / `cryptoUtil` /
  `console`) and the format specification are documented in:
  - [docs/book-source-spec.md](./docs/book-source-spec.md) (JSON structure and entry-function contracts)
  - [docs/book-source-api.md](./docs/book-source-api.md) (host API reference)
  - [docs/book-source-guide.md](./docs/book-source-guide.md) (a from-scratch tutorial)
  - [docs/cloudflare.md](./docs/cloudflare.md) (handling Cloudflare / login / hotlink-protected sites)
  - [docs/book-source-cli.md](./docs/book-source-cli.md) (the standalone `readerx-source` binary:
    run book sources without launching the app, with browser cookies / WebKit challenge solving /
    pulling cookies from Chrome)
- **Enable & capability switches**: each source can be enabled/disabled as a whole, and search /
  discovery / detail / TOC / content can each be toggled separately.
- **Groups**: sources can be organised into groups (filter bar on the management page / inline
  folder button on a row / the "Group" field on the edit page). Group management supports
  creating, renaming, deleting and one-click enable/disable for a whole group; deleting a group
  returns its sources to ungrouped. The Discover page filter bar and the management page share the
  same selection: search / discovery then only runs the enabled sources of that group. Export only
  carries the human-readable `groupName`; import matches groups by name on this device (creating
  them when missing), and the confirmation page can skip group import entirely.
- **Bulk management**: **long-press a source row to enter multi-select**, tap rows to check /
  uncheck, and the header's "Select all" selects the currently visible (filtered) sources; the
  bottom action bar can enable / disable in bulk, add to or remove from a group together, export
  as one JSON array (copied to the clipboard) and delete.
- **Import & export**: single objects or arrays can both be imported and exported (entrance on the
  management page), with automatic normalisation and overwrite-conflict prompts. Besides picking a
  local file / pasting from the clipboard, you can also **fetch a book-source JSON over the
  network** by pasting its http/https URL — no need to download the file first.
- **Online reading**: search results or category discovery → preview on the online book page →
  "Add to shelf" (only TOC metadata is stored); the toast for a newly added book offers
  "Add to group" to file it into a shelf group immediately.
- **Editing & testing**: the source edit page has a built-in "Save and test" that runs one
  capability at a time with your parameters and shows the result plus `console` output.
- **Web login / automatic web authentication (Android / Linux / Windows)**: "Web login" on the
  edit page opens an in-app WebView; after you log in, the site cookies (including the httpOnly
  `cf_clearance`) are captured automatically, persisted per source and injected into the session
  (effective after a restart, not included in book-source JSON export). Source code can also call
  `webview.login(url)` to trigger it. On Android it is a native overlay on top of the Activity; on
  desktop it is a separate login window (the same native experience as the system file picker).
  Every source enables "automatic web authentication" by default: when a request hits a Cloudflare
  challenge (or the `cf_clearance` token expires), a WebView authentication is launched and the
  request retried; this can be turned off per source on the edit page
  (see [docs/cloudflare.md](./docs/cloudflare.md)).
  localStorage / sessionStorage / IndexedDB snapshots of the login state are captured on Android
  and Windows / macOS; **on Linux, WebKitGTK isolates host scripts from page storage**, so that
  platform uses cookies as the only source of login state (see the platform-differences section in
  [docs/cloudflare.md](./docs/cloudflare.md)).

> Book sources are only meant for users to connect to publicly available site content themselves.
> **Disclaimer**: community / third-party book sources have nothing to do with the ReaderX project
> or its author, who took no part in creating or maintaining any of them. Book-source code runs in
> a local sandbox, but the author cannot guarantee its safety — only import sources you trust, and
> read and confirm the prompts when importing and enabling them.

## Form Factors & Platforms

| Platform                | Shell                                           | Notes                                                                        |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Android                 | Phone column + bottom tabs                      | The primary target; local books are imported via `input[type=file]` (SAF)    |
| Linux / Windows desktop | Side navigation + content area (at ≥900px wide) | Narrowing the window below 900px falls back to the phone shell automatically |
| Browser (`pnpm dev`)    | Same as above (by window width)                 | A degraded mode without the Rust backend, for UI work only                   |

Desktop differences are confined to the shell and system integration: window size / minimum size
constraints, native file-picker import, Esc to go back, the "Developer tools" entry in Settings
(the inspector can be opened even in a release build), arrow-key page turns on the reading page,
and repeated launches focusing the existing window instead of starting a second process (single
instance, see `src-tauri/src/single_instance.rs`); page components and the local library are
shared by both — there is no second implementation.

## Logging & Troubleshooting

Frontend and backend share one logging pipeline: on the Rust side `readerx-log` writes everything
to `<app data dir>/logs/<date>/readerx-<start time>.log` (one directory per day, one file per
launch; 2 MB rotation per file, each app keeping the last 7 days up to 32 MB in total), and the
book-source engine, the standalone binary and the frontend inside the WebView all log into the
same file. **Settings → Debug → App log** lets you filter by level, switch between log files,
copy and clear, and switch between "normal" and "verbose" (`READERX_LOG` can override temporarily,
e.g. `READERX_LOG=info,readerx_source=debug`). Details and troubleshooting steps are in
[docs/logging.md](./docs/logging.md).

## Development

```bash
pnpm install
pnpm dev                 # Vite dev server → http://localhost:1420
pnpm exec tsc --noEmit   # type checking
pnpm run i18n:check      # UI dictionary validation (zh/en keys, placeholders, missed Chinese)
pnpm build               # frontend build (dist/)

pnpm tauri dev            # desktop window
pnpm tauri android dev    # Android device / emulator
```

UI copy and the migration conventions are documented in [docs/i18n.md](./docs/i18n.md).

Builds and releases: there are three workflows under `.github/workflows/` — `build-android.yml`
and `build-desktop.yml` (manually triggered, artifacts only, no release) and `release.yml`
(triggered by a `v*` tag; publishes the Android APK + the Linux x86_64 packages + the Windows
x86_64 / aarch64 installers into a single release; desktop packages are split by ABI).
Artifact names follow `readerx-<version>-<platform>-<arch>…` (e.g.
`readerx-0.2.0-linux-x86_64.AppImage`, `readerx-0.2.0-windows-aarch64-setup.exe`); the
collect / rename rules live in `scripts/collect-artifacts.mjs` and are shared by all three
workflows, and download instructions are in `scripts/tip.md`. Quality gates
(`pnpm exec tsc --noEmit` / `pnpm build` / `cargo test`) are run locally as needed.

See [AGENTS.md](./AGENTS.md) for repository collaboration and code conventions
(written in Chinese, like the docs under `docs/`).
