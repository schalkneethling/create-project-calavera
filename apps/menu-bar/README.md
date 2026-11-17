# Calavera menu-bar companion

The optional Tauri macOS companion watches explicitly registered Calavera projects for CLI and artifact updates. It also checks for stable menu-bar app releases.

- Project registration and preferences stay in local application storage.
- Only the registered project's recipe, artifact lock, and state files are read. Registration asks for the recipe path relative to the project, `calavera.config.json` by default, and refuses a path that leaves the project.
- Checks run at launch, every six hours, or when **Check now** is selected; registry traffic only happens during a check. Manual refresh reuses any in-flight check and updates the visible project diagnostics when it completes.
- Update buttons always copy the exact command. The app builds it with the CLI's own command builder, so it runs through the recipe's package manager and passes `--config` when the recipe is not at the default path. While the registered channel matches the channel in the artifact lock, it is the command that `create-project-calavera artifacts status --json` reports as `updateCommand`; otherwise it moves the artifact to the registered channel. When the recipe is missing, unreadable, or incompatible, the app lists the update without a command and names the problem: an unreadable recipe shows the read or parse error. For a missing recipe, `artifacts status` also reports no command. By default, the app leaves opening a terminal to you. You may optionally save a preferred terminal application name, such as `Ghostty` or `iTerm`, and the app will ask macOS to open it at the project. A launch failure is shown without losing the copied command. The app never executes a project update.
- App updates open the corresponding GitHub release. Version 1 has no self-updater.

Run `pnpm --filter @calavera/menu-bar dev` with a Rust toolchain for local development. A `menu-bar-v*` tag runs the signed universal-DMG workflow; the protected `publish` environment must provide the Apple certificate and notarization secrets named in that workflow.
