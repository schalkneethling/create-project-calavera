---
"create-project-calavera": patch
"@schalkneethling/calavera-artifact-core": patch
---

Calavera now accepts an artifact tarball URL from a registry only when it is an `https` URL, or an `http` URL on `localhost`, `127.0.0.1`, or `::1`. Before, a registry's package document could name a `git+ssh:`, `git+https:`, `file:`, or plain `http` tarball URL, and pacote would run git with your SSH agent and credential helpers, read a file on your machine, or fetch over an unencrypted connection. Any other tarball URL, including an `https` URL that names a git repository, such as `https://github.com/owner/repo`, and a `registry.npmjs.org` URL that pacote would move onto a plain-`http` registry on another host, now stops with the error code `EBADTARBALLURL`, before anything is fetched. The error names the package and says why the URL was refused. It quotes the URL's protocol only when the protocol has at most 16 characters, and never the rest of the URL (#1194).
