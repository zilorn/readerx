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

An ebook reader built with **Tauri 2 + SolidJS + TypeScript** for **Android, Linux and Windows**, sharing the same pages and local library across platforms.

[Download the latest release](https://github.com/zilorn/readerx/releases/latest)

## Screenshots

Screenshots use fictional demo data.

<p align="center">
  <img src="./docs/images/mobile-bookshelf.png" alt="Mobile bookshelf" width="300" />
  <img src="./docs/images/mobile-reader.png" alt="Mobile reader" width="300" />
</p>

<p align="center">
  <img src="./docs/images/desktop-bookshelf.png" alt="Desktop bookshelf" width="960" />
</p>

## Features

- **Local library**: import TXT / EPUB / MOBI / PDF, organise books into groups, and track reading progress and bookmarks.
- **Reading and text-to-speech**: chapter navigation, adjustable font size, light / dark / sepia themes, and two-page reading in wide desktop windows; native TTS and custom HTTP speech sources with playback speed controls and a sleep timer.
- **Book sources**: search, category discovery, online reading and offline downloads; JS rules, JSON import / export, groups, bulk management, editing, testing and web login authentication.
- **Sync and backup**: sync books, progress, bookmarks and rules between devices on a local network without an account; full-library ZIP backups with merge or replace restore options.
- **Customisation**: custom chapter-splitting and text replacement rules, with Simplified Chinese and English interfaces.

Android uses bottom navigation. Desktop windows use side navigation at widths ≥900px and switch to the phone layout when narrower.

## Development

Install pnpm and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm dev                 # Web preview: http://localhost:1420, for UI work only
pnpm tauri dev           # Desktop app
pnpm tauri android dev   # Android device / emulator
```

Checks and build:

```bash
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
```

Reuse the existing development server if port 1420 is occupied. Run Rust tests from `src-tauri/`.

## Documentation and Contributing

The documentation below is written in Chinese.

| Documentation | Content |
| --- | --- |
| [Source tutorial](./docs/book-source-guide.md) · [Format specification](./docs/book-source-spec.md) · [API](./docs/book-source-api.md) | Writing and testing book sources |
| [Web authentication](./docs/cloudflare.md) · [Source CLI](./docs/book-source-cli.md) | Login, Cloudflare and the standalone command-line tool |
| [Sync](./docs/sync.md) · [Backup](./docs/backup.md) | Data synchronisation and recovery |
| [Logging and troubleshooting](./docs/logging.md) | Settings → Debug → App log |
| [Internationalisation](./docs/i18n.md) · [Repository guidelines](./AGENTS.md) | Development conventions |
| [Contributing](./CONTRIBUTING.md) | Bug reports, feature requests and pull requests |

## Book Source Usage Notice

ReaderX and its authors respect copyright and other intellectual property rights. Book sources are intended only for content you are authorised to access and use. Public availability does not grant permission to copy, download or distribute content; follow applicable laws and the rights holders' permissions.

Community and third-party book sources are created and maintained by their own authors, independently of the ReaderX project and its authors. Sources run in a local sandbox, but the project cannot guarantee their safety. Only import sources you trust, and read the prompts when importing and enabling them.
