---
"create-project-calavera": patch
---

A dry run that Ctrl+C (SIGINT) or SIGTERM interrupts now removes the temporary folders it created to rebuild a locked artifact package (`calavera-locked-artifact-*`) and to stage an unlocked artifact (`calavera-artifact-stage-*`). It removes each folder by its exact path, so folders that other runs keep in the system's temporary folder stay, and the process still ends by the signal it received. Apply removes these folders the same way when it is interrupted before it no longer needs them (#1081).
