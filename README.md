# EngramView

EngramView is a small desktop app for reading your local Engram memory database by project. It is built for one job: make long-running AI coding history easier to inspect without exposing mutation commands.

The app is intentionally read-only. It can list projects, search memories, inspect metadata, and open full memory content, but it cannot edit, delete, import, export, or migrate Engram data.

## Quick start

```bash
pnpm install
pnpm tauri dev
```

By default, EngramView reads the local database from:

```text
~/.engram/engram.db
```

To point it at another Engram data directory:

```bash
ENGRAM_DATA_DIR=/path/to/.engram pnpm tauri dev
```

## What it does

| Area | Behavior |
| --- | --- |
| Projects | Lists Engram projects with observation, session, prompt, latest-memory, and first-memory metadata. |
| Memories | Shows paginated memory cards with ID, title, type, scope, preview, timestamps, and topic key. |
| Search | Searches the selected project using Engram's FTS index when available. |
| Sorting | Switches the memory list between latest-first and oldest-first. |
| Detail | Opens the full memory content with sync ID, topic key, project, and timestamps. |
| Safety status | Shows whether the app is connected to the expected local Engram database. |

## Why this exists

Engram is excellent at preserving coding-session context, but once a project has hundreds or thousands of observations, terminal search is not always the best reading experience. EngramView gives that local memory a focused visual browser while keeping the database protected from accidental writes.

## Safety model

EngramView is designed as a viewer, not an admin console.

- Opens SQLite with read-only flags.
- Enables `PRAGMA query_only` for an extra SQLite-level write guard.
- Exposes only read-oriented Tauri commands:
  - project list
  - memory list
  - memory detail
  - database info
- Does not expose update, delete, sync, import, export, migration, or shell commands.
- Does not run a local web server for the memory database.

This matters because Engram data is personal development history. The safest default is inspection without mutation.

## Tech stack

| Layer | Choice |
| --- | --- |
| Desktop shell | Tauri 2 |
| Frontend | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS 4 + shadcn/Radix primitives |
| Backend | Rust Tauri commands |
| Database access | `rusqlite` with bundled SQLite |

## Development

```bash
pnpm install
pnpm build
pnpm tauri dev
```

Run Rust checks from the Tauri package:

```bash
cd src-tauri
cargo test
cargo check
```

Create a debug desktop build without bundling an installer:

```bash
pnpm tauri build --debug --no-bundle --ci
```

## Verification checklist

Before publishing a build, run:

```bash
pnpm build
cd src-tauri
cargo test
cargo check
```

Manual smoke test:

- [ ] App opens without requesting write access.
- [ ] Projects load from the expected Engram database.
- [ ] Selecting a project loads paginated memories.
- [ ] Search returns matching memories and can be cleared.
- [ ] Detail view opens the full memory content.
- [ ] Sorting latest-first/oldest-first changes memory order.

## Privacy notes

Do not commit local Engram databases, generated installers, or personal exports. This repository contains the viewer source code only.

The app may display sensitive project memory if your local Engram database contains it. Treat screenshots and recordings as potentially private.

## Project status

EngramView is an MVP for personal local use. The core read-only viewer flow is implemented and tested; future work should stay conservative and preserve the safety boundary.