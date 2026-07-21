# Calavera menu-bar companion

The optional Tauri macOS companion watches explicitly registered Calavera projects for CLI and artifact updates. It also checks for stable menu-bar app releases.

- Project registration and preferences stay in local application storage.
- Only the registered project's recipe, artifact lock, and state files are read.
- Checks run at launch, every six hours, or when **Check now** is selected; registry traffic only happens during a check. Manual refresh reuses any in-flight check and updates the visible project diagnostics when it completes.
- Update buttons always copy the exact command. By default, the app leaves opening a terminal to you. You may optionally save a preferred terminal application name, such as `Ghostty` or `iTerm`, and the app will ask macOS to open it at the project. A launch failure is shown without losing the copied command. The app never executes a project update.
- App updates open the corresponding GitHub release. Version 1 has no self-updater.

Run `pnpm --filter @calavera/menu-bar dev` with a Rust toolchain for local development. A `menu-bar-v*` tag runs the signed universal-DMG workflow; the protected `publish` environment must provide the Apple certificate and notarization secrets named in that workflow.
