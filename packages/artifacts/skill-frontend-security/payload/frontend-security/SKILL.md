---
name: frontend-security
description: Audit frontend codebases for security vulnerabilities and bad practices. Use when performing security reviews, auditing code for XSS/CSRF/DOM vulnerabilities, checking Content Security Policy configurations, validating input handling, reviewing file upload security, or examining Node.js/NPM dependencies. Target frameworks include web platform (vanilla HTML/CSS/JS), React, Astro, Twig templates, Node.js, and Bun. Based on OWASP security guidelines.
---

# Frontend Security Audit Skill

Perform security audits of frontend-adjacent codebases by mapping trust
boundaries, tracing untrusted data into dangerous sinks, and then using pattern
searches as supporting evidence. This skill covers browser/frontend concerns
first, but also routes related Node.js, npm, auth/session, and upload findings
to the correct references when they affect frontend security.

## Audit Process

1. **Map the application context** - Identify routes, rendering models, API
   boundaries, authentication/session mechanisms, third-party scripts, uploads,
   package-manager entry points, and deployment/runtime assumptions.
2. **Trace data flow** - List untrusted sources such as URL parameters, forms,
   storage, postMessage, server responses, uploaded files, cookies, headers, and
   package metadata. Follow them to DOM, navigation, template, command,
   filesystem, database, network, and log sinks.
3. **Scan for evidence** - Use `rg` searches, framework-aware checks, and AST or
   Semgrep rules where useful. Treat matches as leads to review in context, not
   proof of a vulnerability by themselves.
4. **Review defenses** - Check output encoding, sanitization, CSP, CSRF
   controls, token storage, input validation, upload handling, dependency
   controls, and framework-specific escape hatches.
5. **Rate risk in context** - Assign severity from exploitability, impact,
   reachability, privileges required, user interaction, data sensitivity, and
   compensating controls.
6. **Report findings** - Include evidence, affected trust boundary, exploit
   scenario, severity rationale, remediation, and the most relevant reference.

## Scope Routing

Use the main workflow for browser, template, and frontend framework issues. Load
the narrower references when the audit touches one of these areas:

| Finding area                                                | Route to                             |
| ----------------------------------------------------------- | ------------------------------------ |
| Browser XSS, unsafe URLs, tabnabbing, HTML injection        | `references/xss-prevention.md`       |
| DOM sinks, DOM clobbering, postMessage, client-side storage | `references/dom-security.md`         |
| CSP headers, nonce/hash policies, Trusted Types hardening   | `references/csp-configuration.md`    |
| Forms, cookie-based auth, state-changing requests           | `references/csrf-protection.md`      |
| URL, number, date, schema, and structured input parsing     | `references/input-validation.md`     |
| React, Astro, Twig, SSR, hydration, and template patterns   | `references/framework-patterns.md`   |
| File uploads, generated downloads, archive handling         | `references/file-upload-security.md` |
| JWT lifecycle, token storage, refresh flows                 | `references/jwt-security.md`         |
| Node runtime, npm supply chain, scripts, command execution  | `references/nodejs-npm-security.md`  |

Name the boundary when a finding is outside pure frontend code. For example,
"browser-to-API CSRF", "frontend-triggered upload processing", or
"package-script supply-chain risk" is clearer than treating every issue as a
frontend vulnerability.

State scope limits in the report. This skill can identify frontend-triggered
server/API, upload, auth, or supply-chain risks, but deep backend authorization,
database, infrastructure, malware, or incident-response review should be routed
to the appropriate specialist workflow.

## Evidence Searches

Start with the broad extension set below, then narrow it to the project. Prefer
AST-aware tools or Semgrep for final confirmation when syntax or multiline
structure matters.

```bash
FRONTEND_GLOBS='*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,astro,vue,svelte,html,htm,twig,html.twig,njk,ejs,hbs,mustache,liquid,mdx}'
```

### XSS, DOM, and Navigation Leads

```bash
# React and JSX escape hatches
rg -n "dangerouslySetInnerHTML|suppressHydrationWarning" --glob "$FRONTEND_GLOBS"

# Direct HTML parsing and DOM mutation
rg -n "\\.(innerHTML|outerHTML)\\s*=|insertAdjacentHTML|document\\.write|DOMParser" --glob "$FRONTEND_GLOBS"
rg -n "\\.(srcdoc|text|html)\\s*=|\\$\\([^)]*\\)\\.html\\(" --glob "$FRONTEND_GLOBS"

# URL, redirect, and new-window sinks
rg -n "location\\.(href|assign|replace)\\s*=|window\\.open\\(|target=[\"']_blank" --glob "$FRONTEND_GLOBS"
rg -n "javascript:|data:text/html|blob:" --glob "$FRONTEND_GLOBS"

# Dynamic code execution
rg -n "\\beval\\s*\\(|new Function\\s*\\(|set(?:Timeout|Interval)\\s*\\(\\s*['\"]" --glob "$FRONTEND_GLOBS"

# Template bypasses
rg -n "\\|raw|autoescape\\s+false|unsafeHTML|html\\s*`" --glob "$FRONTEND_GLOBS"
```

### CSRF, Auth, and API Leads

```bash
# Forms and state-changing requests
rg -n "<form|method=[\"']post|fetch\\(|axios\\.|ky\\.|got\\." --glob "$FRONTEND_GLOBS"
rg -nUP "fetch\\s*\\([^)]*method\\s*:\\s*['\"](?:POST|PUT|PATCH|DELETE)['\"]" --glob "$FRONTEND_GLOBS"
rg -n "\\b(?:post|put|patch|delete)\\s*\\(" --glob "$FRONTEND_GLOBS"

# Token and session storage
rg -n "(localStorage|sessionStorage|indexedDB|document\\.cookie)\\b" --glob "$FRONTEND_GLOBS"
rg -n "(Authorization|Bearer|refresh[_-]?token|access[_-]?token|id[_-]?token|jwt)" --glob "$FRONTEND_GLOBS"
```

### Secret, Upload, and Runtime Leads

```bash
# Hardcoded secrets and environment exposure
rg -n -i "(api[_-]?key|client[_-]?secret|password|private[_-]?key|token)\\s*[:=]" --glob "$FRONTEND_GLOBS" --glob "*.env*"

# Upload and download paths
rg -n "(multer|busboy|formidable|FileReader|URL\\.createObjectURL|Content-Disposition|extractAllTo|adm-zip|yauzl)" --glob "$FRONTEND_GLOBS" --glob "package.json"

# npm and command-execution risk
rg -n "\"(preinstall|install|postinstall|prepare)\"|child_process|exec\\(|execFile\\(|spawn\\(" --glob "package.json" --glob "*.{js,ts,mjs,cjs,mts,cts,sh,bash,zsh,yml,yaml,toml,json}" --glob "Dockerfile" --glob "*.dockerfile" --glob ".github/workflows/*"
```

When a search has many matches, sample representative paths first, then follow
the source-to-sink chain for code that handles untrusted input or sensitive
state. Do not assign severity from the search pattern alone.

## Reference Documentation

Load these references based on findings:

- **XSS vulnerabilities found**: See `references/xss-prevention.md`
- **CSRF concerns**: See `references/csrf-protection.md`
- **DOM manipulation issues**: See `references/dom-security.md`
- **CSP review needed**: See `references/csp-configuration.md`
- **Input handling issues**: See `references/input-validation.md`
- **Node.js/NPM audit**: See `references/nodejs-npm-security.md`
- **Framework-specific patterns**: See `references/framework-patterns.md`
- **File upload handling**: See `references/file-upload-security.md`
- **JWT implementation**: See `references/jwt-security.md`

## Risk-Based Severity

Use vulnerability class as a starting clue, then rate the specific finding:

- **Critical** - Likely exploit path with high impact, such as unauthenticated
  account takeover, privileged stored XSS, exposed secrets that grant production
  access, or remote code execution in reachable build/runtime paths.
- **High** - Plausible exploit with meaningful user, data, integrity, or supply
  chain impact, especially when reachable by ordinary users or low-privilege
  attackers.
- **Medium** - Real weakness with limited reach, lower sensitivity, meaningful
  prerequisites, or compensating controls that reduce immediate impact.
- **Low** - Hard-to-exploit issue, defense-in-depth gap, informational exposure,
  deprecated pattern, or hygiene improvement with weak immediate impact.

Record the severity rationale using these factors:

- exploitability and required attacker capability;
- user interaction and privileges required;
- reachability from production code paths;
- data sensitivity and integrity impact;
- persistence, lateral movement, and blast radius;
- existing controls such as CSP, SameSite cookies, validation, sandboxing,
  authorization, monitoring, and dependency pinning.

## Report Format

```markdown
## Security Audit Report

### Summary

- Critical: X findings
- High: X findings
- Medium: X findings
- Low: X findings

### Critical Findings

#### [CRITICAL-001] Title

- **Location**: file:line
- **Trust boundary**: Source to sink being crossed
- **Evidence**: Code snippet or search result
- **Exploit scenario**: How an attacker reaches the issue
- **Risk**: Description of the vulnerability
- **Severity rationale**: Why this is Critical/High/Medium/Low in this project
- **Remediation**: How to fix
- **Reference**: OWASP link

### High Findings

[...]
```

## OWASP Reference Links

For comprehensive guidance, consult these OWASP cheatsheets directly:

- XSS Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- DOM XSS Prevention: https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html
- CSRF Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- CSP: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
- Input Validation: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- HTML5 Security: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html
- DOM Clobbering: https://cheatsheetseries.owasp.org/cheatsheets/DOM_Clobbering_Prevention_Cheat_Sheet.html
- Node.js Security: https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html
- NPM Security: https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html
- AJAX Security: https://cheatsheetseries.owasp.org/cheatsheets/AJAX_Security_Cheat_Sheet.html
- File Upload: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- Error Handling: https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- JWT Security: https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html
- User Privacy: https://cheatsheetseries.owasp.org/cheatsheets/User_Privacy_Protection_Cheat_Sheet.html
- gRPC Security: https://cheatsheetseries.owasp.org/cheatsheets/gRPC_Security_Cheat_Sheet.html
