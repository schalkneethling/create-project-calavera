---
"create-project-calavera": patch
---

A dry run that Ctrl+C (SIGINT) or SIGTERM interrupts now removes the temporary folders it created to rebuild a locked artifact package (`calavera-locked-artifact-*`) and to stage an unlocked artifact (`calavera-artifact-stage-*`). It removes each folder by its exact path, so folders that other runs keep in the system's temporary folder stay, and the process still ends by the signal it received, including while a subprocess such as `vp fmt` runs. The removal runs through `signal-exit`, which execa already uses, so when another signal handler keeps the process running, the folders stay until the process exits. When apply is interrupted while it still holds a rebuilt locked package, it removes that `calavera-locked-artifact-*` folder the same way (#1081).
