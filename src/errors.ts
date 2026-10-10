/** Exception hierarchy shared across the harness. */

/**
 * TASK-1263/1265: these messages reach the user twice — the CLI prints them,
 * and chat shows them after "❌ 这一步没做成（<命令>）：". They are written in
 * Chinese with the machine id kept verbatim, so the sentence reads naturally
 * while still naming the object the user typed.
 */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends HarnessError {}

export class DuplicateRepositoryError extends HarnessError {
  constructor(id: string) {
    super(`仓库已存在：${id}`);
  }
}

export class RepositoryNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到仓库：${id}`);
  }
}

export class DuplicateTaskError extends HarnessError {
  constructor(id: string) {
    super(`任务已存在：${id}`);
  }
}

export class TaskNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到任务：${id}`);
  }
}

export class WorkspaceError extends HarnessError {}

export class AgentExecutionError extends HarnessError {}

export class RunNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到运行记录：${id}`);
  }
}

export class RunConflictError extends HarnessError {
  constructor(id: string, message: string) {
    super(`运行 ${id} 现在不能被认领：${message}`);
  }
}

export class DuplicateActiveRunError extends HarnessError {
  constructor(taskId: string) {
    super(`任务 ${taskId} 已经有一个在执行中的运行`);
  }
}

export class RunNotCancellableError extends HarnessError {
  constructor(id: string, status: string) {
    super(`运行 ${id} 不能取消（当前状态 ${status}）`);
    this.name = "RunNotCancellableError";
  }
}

export class WorkerExecutionError extends HarnessError {}

export class DuplicateProblemError extends HarnessError {
  constructor(id: string) {
    super(`需求已存在：${id}`);
  }
}

export class ProblemNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到需求：${id}`);
  }
}

export class ClarificationNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到这个待确认的问题：${id}`);
  }
}

export class DuplicateSpecificationError extends HarnessError {
  constructor(id: string) {
    super(`规格已存在：${id}`);
  }
}

export class DuplicateTaskDependencyError extends HarnessError {
  constructor(taskId: string, dependsOnTaskId: string) {
    super(`任务依赖已存在：${taskId} 依赖 ${dependsOnTaskId}`);
  }
}

export class DuplicateDeliveryError extends HarnessError {
  constructor(id: string) {
    super(`交付已存在：${id}`);
  }
}

export class DeliveryNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到交付：${id}`);
  }
}

export class SpecificationNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到规格：${id}`);
  }
}

export class ExecutionNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到执行记录：${id}`);
  }
}

export class ExecutionTimeoutError extends HarnessError {
  constructor(runId: string) {
    super(`执行超时：${runId}`);
  }
}

export class ExecutionCancelledError extends HarnessError {
  constructor(runId: string) {
    super(`执行已取消：${runId}`);
  }
}

export class ConversationNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`没有找到会话：${id}`);
  }
}

/**
 * TASK-1268: a GitHub REST call came back non-2xx. The status is kept because
 * callers must tell "the workflow does not exist" (404, a configuration
 * problem worth reporting) apart from "the API is unhappy right now" (keep
 * watching).
 */
export class GitHubRequestError extends HarnessError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
