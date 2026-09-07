# AGENTS.md

Guidance for AI coding agents and human contributors working in this repository.

## Project

> TODO: what this project is — purpose, stack, and full layout once decided.

## Task-driven workflow for AI coding

- The repository is organized around tasks under `tasks/`, one directory per
  task.
- Each task is defined by `TASK.md` (context, starting state, objective,
  constraints, acceptance criteria, verification).
- A task may carry `workspace/` (starting code to edit) and `verify/`
  (verification scripts/tests); their format is decided per task.
- Execute a task: read `TASK.md`, touch only what the task allows, run the
  task's verification, and finish only when its acceptance criteria pass.
- When a task is done, summarize the outcome and record notes inside the task
  directory.

## Creating a task

Copy `tasks/_template/` to `tasks/<task-id>-<short-name>/` and fill in
`TASK.md`. See [tasks/README.md](tasks/README.md).

## Commands

> TODO: setup/run/verify commands matching the stack once chosen.

## Conventions

> TODO: style, tests, docs, and anything agents must not do.

## Verification

A change is complete when the task's acceptance criteria pass and its
verification steps succeed.
