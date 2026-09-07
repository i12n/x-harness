# tasks

This repository is task-driven and formatted for AI coding execution: a
driver or agent picks a task, works it, and verifies completion.

## Task format

```text
tasks/<task-id>-<short-name>/
  TASK.md      # context, starting state, objective, constraints,
               # acceptance criteria, verification
  workspace/   # starting state the agent edits (per task)
  verify/      # verification scripts/tests (per task)
```

A task is done when its acceptance criteria pass and its verification steps
succeed.

## Adding a task

Copy `_template/` to `tasks/<task-id>-<short-name>/`, then fill in `TASK.md`
and — once the stack is known — the starting code and verification files:

```bash
cp -r _template tasks/<task-id>-<short-name>
```
