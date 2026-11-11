# Glossary Map

This repo is a pnpm monorepo with one bounded context per workspace package. Each context's `GLOSSARY.md` is created lazily by `/domain-modeling` when terms actually get resolved — a missing file just means no glossary yet.

| Context              | Path                            | GLOSSARY.md                                |
| -------------------- | ------------------------------- | ------------------------------------------ |
| Bot / runtime        | `packages/bot/`                 | `packages/bot/GLOSSARY.md`                 |
| UI                   | `packages/ui/`                  | `packages/ui/GLOSSARY.md`                  |
| Voice                | `packages/voice/`               | `packages/voice/GLOSSARY.md`               |
| Plugin SDK           | `packages/plugin-sdk/`          | `packages/plugin-sdk/GLOSSARY.md`          |
| Plugin wire contract | `packages/plugin-wire/`         | `packages/plugin-wire/GLOSSARY.md`         |
| Plugin: example      | `packages/plugin-example/`      | `packages/plugin-example/GLOSSARY.md`      |
| Plugin: reminder     | `packages/plugin-reminder/`     | `packages/plugin-reminder/GLOSSARY.md`     |
| Plugin scaffolder    | `packages/create-karyl-plugin/` | `packages/create-karyl-plugin/GLOSSARY.md` |

System-wide ADRs live in `docs/adr/`; context-scoped ADRs in `packages/<pkg>/docs/adr/`.
