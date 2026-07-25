# Baseline Target Explorer

Static browser for explaining moving and fixed Baseline targets and recommending the earliest target compatible with selected CSS features.

```bash
pnpm --filter @calavera/baseline-explorer dev
pnpm --filter @calavera/baseline-explorer build
```

The production build is written to `apps/baseline-explorer/dist`. Deploy that directory to `baseline.calavera.schalkneethling.com` as an independent static application. Query parameters preserve the selected target or feature IDs in shareable URLs.
