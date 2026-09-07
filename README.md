# x-harness

> TODO: describe this project in one or two sentences once its purpose is set.

An AI-coding-driven repository: tasks are the driving unit, and each task is
formatted so an AI coding agent can execute it end to end — read `TASK.md`,
edit the task workspace, run verification, and finish when the acceptance
criteria pass.

## Status

Initialized scaffold — language-neutral; no project code or stack-specific
configuration yet.

## Layout

```text
tasks/
  _template/               # copy this to start a new task
    TASK.md                # task definition
    workspace/             # starting code the agent edits
    verify/                # verification scripts/tests
  <task-id>-<short-name>/  # one directory per task
AGENTS.md                  # guidance for AI coding agents
README.md
```

## Creating a task

1. Copy `tasks/_template/` to `tasks/<task-id>-<short-name>/`.
2. Fill in `TASK.md`: context, starting state, objective, constraints,
   acceptance criteria, verification.
3. Put starting code under `workspace/` and verification under `verify/` when
   the stack is known.

See [tasks/README.md](tasks/README.md).

## For AI agents

See [AGENTS.md](AGENTS.md) for guidance.
