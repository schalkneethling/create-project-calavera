# Release rehearsal record

Copy this file into the release issue or another durable release record. Do not commit credentials, registry tokens, certificate material, or private project paths.

## Identity

- Date and operator:
- Source commit:
- GitHub release or disposable rehearsal reference:
- `pnpm release:rehearse` result:
- `pnpm workflow:check` result:
- `pnpm release:status` result:

## Independent surfaces

| Surface                                           | Before | Candidate or deployed | Evidence | Unrelated surfaces unchanged |
| ------------------------------------------------- | ------ | --------------------- | -------- | ---------------------------- |
| Composer (`dist-web`)                             |        |                       |          |                              |
| Baseline Explorer (`apps/baseline-explorer/dist`) |        |                       |          |                              |
| CLI                                               |        |                       |          |                              |
| Baseline core                                     |        |                       |          |                              |
| Artifact core                                     |        |                       |          |                              |
| Selected artifact                                 |        |                       |          |                              |
| Unrelated artifact                                |        |                       |          |                              |
| macOS companion                                   |        |                       |          |                              |
| MCP/WebMCP parity                                 |        |                       |          |                              |
| Multiple-project registration                     |        |                       |          |                              |
| Notification deduplication                        |        |                       |          |                              |
| Copy-only behavior                                |        |                       |          |                              |
| Preferred-terminal launch                         |        |                       |          |                              |

## Artifact channel journey

- Selected artifact ID and package:
- `next` version and dist-tag evidence:
- Clean fixture install result and exact lock version:
- Offline locked reapply result:
- Targeted update result:
- Unrelated lock entry before and after:
- Local-edit refusal result:
- Integrity or registry failure result:
- `artifacts doctor` result:
- Stable version and `latest` dist-tag evidence:

## Recovery and sign-off

- Partial failure or rollback exercised:
- Last known-good static deployment commits:
- Signed/notarized/stapled DMG evidence:
- Clean-Mac installation result:
- Follow-up issues:
- Sign-off:
