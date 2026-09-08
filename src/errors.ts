/** Exception hierarchy shared across the harness. */

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends HarnessError {}

export class DuplicateRepositoryError extends HarnessError {
  constructor(id: string) {
    super(`repository already exists: ${id}`);
  }
}

export class RepositoryNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`repository not found: ${id}`);
  }
}

export class DuplicateTaskError extends HarnessError {
  constructor(id: string) {
    super(`task already exists: ${id}`);
  }
}

export class TaskNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`task not found: ${id}`);
  }
}

export class WorkspaceError extends HarnessError {}

export class AgentExecutionError extends HarnessError {}

export class RunNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`run not found: ${id}`);
  }
}

export class RunConflictError extends HarnessError {
  constructor(id: string, message: string) {
    super(`run ${id} is not claimable: ${message}`);
  }
}

export class WorkerExecutionError extends HarnessError {}
