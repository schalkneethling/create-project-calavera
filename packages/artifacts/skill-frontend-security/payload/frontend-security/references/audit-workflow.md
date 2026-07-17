# Security Audit Evidence and Reporting

## Evidence Searches

Start broad, then narrow to the project's languages and trust boundaries. Prefer AST-aware tools or
Semgrep when syntax or multiline structure matters.

```bash
FRONTEND_GLOBS='*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,astro,vue,svelte,html,htm,twig,njk,ejs,hbs,mdx}'
rg -n "dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\\.write|DOMParser" --glob "$FRONTEND_GLOBS"
rg -n "location\\.(href|assign|replace)|window\\.open|javascript:|data:text/html" --glob "$FRONTEND_GLOBS"
rg -n "\\beval\\s*\\(|new Function\\s*\\(|set(?:Timeout|Interval)\\s*\\(\\s*['\"]" --glob "$FRONTEND_GLOBS"
rg -n "<form|method=[\"']post|fetch\\(|axios\\.|Authorization|Bearer|refresh[_-]?token|jwt" --glob "$FRONTEND_GLOBS"
rg -n "localStorage|sessionStorage|indexedDB|document\\.cookie" --glob "$FRONTEND_GLOBS"
rg -n -i "api[_-]?key|client[_-]?secret|password|private[_-]?key" --glob "$FRONTEND_GLOBS" --glob "*.env*"
rg -n "multer|busboy|formidable|Content-Disposition|extractAllTo|adm-zip|yauzl" --glob "$FRONTEND_GLOBS" --glob "package.json"
rg -n '"(preinstall|install|postinstall|prepare)"|child_process|exec\\(|execFile\\(|spawn\\(' --glob "package.json" --glob "*.{js,ts,mjs,cjs,mts,cts,sh,yml,yaml,toml,json}"
```

Follow representative matches from an untrusted source to a sensitive sink before reporting them.

## Report Template

```markdown
## Security Audit Report

### Summary

- Critical: X
- High: X
- Medium: X
- Low: X

#### [SEVERITY-001] Finding title

- **Location**: file:line
- **Trust boundary**: source to sink
- **Evidence**: confirmed code path
- **Exploit scenario**: attacker capability and path
- **Risk**: concrete impact
- **Severity rationale**: exploitability, reachability, impact, and controls
- **Remediation**: focused fix
- **Reference**: authoritative guidance
```

## References

- [XSS Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [DOM XSS Prevention](https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html)
- [CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Content Security Policy](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [Input Validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [DOM Clobbering Prevention](https://cheatsheetseries.owasp.org/cheatsheets/DOM_Clobbering_Prevention_Cheat_Sheet.html)
- [Node.js Security](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
- [File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [Error Handling](https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html)
- [JWT Security](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
