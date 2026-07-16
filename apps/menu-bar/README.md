# Calavera menu-bar companion

The optional Tauri macOS companion watches explicitly registered Calavera projects for CLI and artifact updates. It also checks for stable menu-bar app releases.

- Project registration and preferences stay in local application storage.
- Only the registered project's recipe, artifact lock, and state files are read.
- Checks run at launch and every six hours; registry traffic only happens during a check.
- Update buttons copy the exact command and open Terminal at the project. The app never executes a project update.
- App updates open the corresponding GitHub release. Version 1 has no self-updater.

Run `pnpm --filter @calavera/menu-bar dev` with a Rust toolchain for local development. A `menu-bar-v*` tag runs the signed universal-DMG workflow; the protected `publish` environment must provide the Apple certificate and notarization secrets named in that workflow.
