# Contributing

## Prerequisites

- macOS on Apple Silicon (the app uses macOS-only audio + Calendar APIs)
- Node.js 22 LTS

## Setup

```bash
npm install        # installs deps; postinstall patches the Electron app bundle
npm run rebuild     # rebuild better-sqlite3 against the Electron ABI
npm run dev         # launch in dev mode (renderer hot-reloads)
```

After changing anything under `electron/` (main process), run `npm run build` and relaunch, the main process does not hot-reload.

## Quality gates

CI runs these on every push and pull request (see `.github/workflows/ci.yml`). Run them locally before pushing:

```bash
npm run lint          # ESLint (flat config)
npm run format:check  # Prettier
npm run typecheck     # tsc --noEmit
npm run build         # electron-vite build
```

Auto-fix where possible:

```bash
npm run lint:fix
npm run format
```

## Conventions

- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, …).
- All IPC handlers must go through `safeHandle(channel, schema, fn)` with a Zod schema, never register raw `ipcMain` handlers.
- Add database migrations sequentially under `migrations/`; never edit an existing migration.
