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

export class DuplicateActiveRunError extends HarnessError {
  constructor(taskId: string) {
    super(`task ${taskId} already has an active run`);
  }
}

export class RunNotCancellableError extends HarnessError {
  constructor(id: string, status: string) {
    super(`run ${id} is not cancellable (status is ${status})`);
    this.name = "RunNotCancellableError";
  }
}

export class WorkerExecutionError extends HarnessError {}

export class DuplicateProblemError extends HarnessError {
  constructor(id: string) {
    super(`problem already exists: ${id}`);
  }
}

export class ProblemNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`problem not found: ${id}`);
  }
}

export class ClarificationNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`clarification not found: ${id}`);
  }
}

export class DuplicateSpecificationError extends HarnessError {
  constructor(id: string) {
    super(`specification already exists: ${id}`);
  }
}

export class DuplicateTaskDependencyError extends HarnessError {
  constructor(taskId: string, dependsOnTaskId: string) {
    super(`task dependency already exists: ${taskId} depends on ${dependsOnTaskId}`);
  }
}

export class SpecificationNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`specification not found: ${id}`);
  }
}

export class ExecutionNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`execution not found: ${id}`);
  }
}

export class ExecutionTimeoutError extends HarnessError {
  constructor(runId: string) {
    super(`execution timed out: ${runId}`);
  }
}

export class ExecutionCancelledError extends HarnessError {
  constructor(runId: string) {
    super(`execution cancelled: ${runId}`);
  }
}

export class ConversationNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`conversation not found: ${id}`);
  }
}
