---
"create-project-calavera": patch
"@schalkneethling/calavera-artifact-core": patch
---

Calavera no longer follows a redirect that would move an artifact lookup or download to plain `http` on a host other than `localhost`, `127.0.0.1`, or `::1`. Before, a registry or tarball host on `https` could redirect to plain `http`, so anyone on the network could see which package was fetched and, for a lookup, replace the package document. A package document lookup that started on `https`, or passed through it, and any tarball download, now stops before the `http` request with the error code `EINSECUREREDIRECT`. The error names the package and the two protocols, and quotes no URL. Redirects between `https` hosts, between loopback `http` hosts, and on a plain-`http` registry that your own user configuration or environment names still work, and proxy settings apply as before (#1207).
