---
"create-project-calavera": patch
---

A rollback of an interrupted artifact transaction no longer deletes edits you made since the transaction stopped. The transaction journal now records a fingerprint of what each step writes, and before the rollback replaces or removes anything, it compares each file and folder it would replace or remove with that fingerprint. When one changed, such as an edited `.gitignore` or a file added to a newly installed skill folder, the rollback changes nothing, names each changed path, and tells you to move it out of the project to keep the edits, or delete it to discard them, then run the command again. A journal written by an earlier Calavera version records no fingerprint, so the rollback stops the same way before it replaces or removes any path that exists (#1174).
