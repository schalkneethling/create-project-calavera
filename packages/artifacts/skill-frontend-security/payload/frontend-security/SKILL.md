---
name: frontend-security
description: Audit frontend codebases for security vulnerabilities and bad practices. Use when performing security reviews, auditing code for XSS/CSRF/DOM vulnerabilities, checking Content Security Policy configurations, validating input handling, reviewing file upload security, or examining Node.js/NPM dependencies. Target frameworks include web platform (vanilla HTML/CSS/JS), React, Astro, Twig templates, Node.js, and Bun. Based on OWASP security guidelines.
---

# Frontend Security Audit Skill

Audit frontend-adjacent code by mapping trust boundaries, tracing untrusted data into dangerous
sinks, and using searches as supporting evidence. Cover browser/frontend concerns first, then route
related server, package, authentication, and upload findings to the relevant reference.

## Workflow

1. Map routes, rendering models, APIs, authentication/session boundaries, third-party scripts,
   uploads, package-manager entry points, and deployment assumptions.
2. List untrusted sources such as URL parameters, forms, storage, `postMessage`, responses, files,
   cookies, headers, and package metadata. Trace them to DOM, navigation, command, filesystem,
   database, network, and log sinks.
3. Load `references/audit-workflow.md` for focused evidence searches. Treat matches as leads, not
   proof; use AST-aware tooling where syntax or multiline structure matters.
4. Review output encoding, sanitization, CSP, CSRF, token storage, input validation, uploads,
   dependencies, and framework escape hatches.
5. Rate the confirmed finding from exploitability, impact, reachability, required privileges, user
   interaction, data sensitivity, and compensating controls.
6. Report the affected trust boundary, evidence, exploit scenario, severity rationale, remediation,
   and authoritative reference using the template in `references/audit-workflow.md`.

## Reference Routing

| Finding area                                               | Load                                 |
| ---------------------------------------------------------- | ------------------------------------ |
| Browser XSS, unsafe URLs, tabnabbing, HTML injection       | `references/xss-prevention.md`       |
| DOM sinks, clobbering, postMessage, client storage         | `references/dom-security.md`         |
| CSP headers, nonces, hashes, Trusted Types                 | `references/csp-configuration.md`    |
| Cookie auth, forms, state-changing requests                | `references/csrf-protection.md`      |
| URL, number, date, schema, and path validation             | `references/input-validation.md`     |
| React, Astro, Twig, SSR, hydration, templates              | `references/framework-patterns.md`   |
| Uploads, downloads, archives, quarantine                   | `references/file-upload-security.md` |
| JWT lifecycle, storage, fingerprints, refresh flows        | `references/jwt-security.md`         |
| Node runtime, npm supply chain, scripts, command execution | `references/nodejs-npm-security.md`  |

Name boundaries precisely, for example “browser-to-API CSRF,” “frontend-triggered upload
processing,” or “package-script supply-chain risk.” State scope limits: route deep backend
authorization, database, infrastructure, malware, and incident-response work to specialists.

## Severity

- **Critical**: likely high-impact exploit such as unauthenticated account takeover, privileged
  stored XSS, production credential exposure, or reachable remote code execution.
- **High**: plausible exploit with meaningful user, data, integrity, or supply-chain impact.
- **Medium**: real weakness with limited reach, prerequisites, lower sensitivity, or meaningful
  compensating controls.
- **Low**: hard-to-exploit or defense-in-depth gap, deprecated pattern, or hygiene issue.

Always record why the project-specific evidence supports the chosen severity. Consider attacker
capability, interaction, privileges, production reachability, persistence, blast radius, and
existing controls. Do not assign severity from a search result alone.
