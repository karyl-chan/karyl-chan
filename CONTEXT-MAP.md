# Context Map

This repo is a pnpm monorepo with one bounded context per workspace package. Each context's `CONTEXT.md` is created lazily by `/domain-modeling` when terms actually get resolved — a missing file just means no glossary yet.

| Context                | Path                           | CONTEXT.md                          |
| ---------------------- | ------------------------------ | ----------------------------------- |
| Bot / runtime          | `packages/bot/`                | `packages/bot/CONTEXT.md`           |
| UI                     | `packages/ui/`                 | `packages/ui/CONTEXT.md`            |
| Voice                  | `packages/voice/`              | `packages/voice/CONTEXT.md`         |
| Plugin SDK             | `packages/plugin-sdk/`         | `packages/plugin-sdk/CONTEXT.md`    |
| Plugin wire contract   | `packages/plugin-wire/`        | `packages/plugin-wire/CONTEXT.md`   |
| Plugin: example        | `packages/plugin-example/`     | `packages/plugin-example/CONTEXT.md` |
| Plugin: reminder       | `packages/plugin-reminder/`    | `packages/plugin-reminder/CONTEXT.md` |
| Plugin scaffolder      | `packages/create-karyl-plugin/` | `packages/create-karyl-plugin/CONTEXT.md` |

System-wide ADRs live in `docs/adr/`; context-scoped ADRs in `packages/<pkg>/docs/adr/`.
