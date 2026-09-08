# AGENTS.md

Guidance for AI coding agents and human contributors working in this repository.

## Project

`ai-harness`: an AI Coding Harness v0.1 (TypeScript, Node >= 18, ESM) that
drives coding tasks end to end. The authoritative plan is
[docs/ai-coding-harness-v0.1.md](docs/ai-coding-harness-v0.1.md); follow its
module vocabulary (Task / Scheduler / Run / Worker / Workspace / Agent Adapter /
Verification / Loop) and its Phase 1..8 implementation order — do not jump
ahead of the phase being implemented.

## Commands

```bash
npm install
npm test                 # vitest unit tests
npm run typecheck        # strict TypeScript check
npm run build            # compile to dist/
npm run db:migrate       # apply migrations/ against Postgres

ai repository|task ...          # CLI (or: AI_STORAGE=memory ...)
```

## Conventions

- TypeScript strict mode, ESM (`NodeNext`); run `npm run typecheck` before
  finishing.
- Tests use Vitest and live in `tests/`; every new behavior adds a unit test.
  Tests must not require a running Postgres — use `InMemoryRepositoryStore`.
- Persistence goes through store interfaces (`src/store/`); Postgres stores
  map rows to domain models and schema lives in `migrations/`.
- Keep the core minimal: do not add RabbitMQ/Kafka, Kubernetes, RAG, vector
  DBs, or a Web UI in v0.1 (see plan section 一).

## Verification before finishing a change

`npm run typecheck` and `npm test` must pass; when touching the schema, apply
`npm run db:migrate` against a Postgres instance and exercise the affected CLI
path.
