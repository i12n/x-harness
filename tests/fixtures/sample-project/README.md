# sample-project

A generic, dependency-free fixture used by the Phase 11 acceptance suite.

The sample task is to implement `greet(name)` in `src/index.js` so that
`node test/verify.js` passes.

## Checks

Three independent, zero-dependency checks (used by the Phase 12 acceptance
suite to exercise multi-check verification and evidence aggregation):

```bash
npm run lint   # node scripts/lint.js  — structural rules over src/
npm test       # node test/verify.js   — greet(name) behaves as specified
npm run build  # node scripts/build.js — module loads and exposes greet, writes dist/
```

No packages are installed: every check uses Node built-ins only, so the fixture
stays offline and reproducible.
