import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, AgentEngine, AgentResult } from "../../../src/agent/types.js";
import { ConversationService } from "../../../src/conversation/service.js";
import {
  CommandDispatcher,
  InMemoryIdempotencyStore,
  ScriptedIntentEngine,
  handleIntent,
  type AuthorizationContext,
  type CommandResult,
  type Role,
} from "../../../src/command/index.js";
import { createProblemCommandHandlers } from "../../../src/command/handlers/problem.js";
import { createReviewCommandHandlers } from "../../../src/command/handlers/review.js";
import { createTaskRunCommandHandlers } from "../../../src/command/handlers/taskRun.js";
import { FeishuEventIngestion } from "../../../src/channel/feishu/webhook.js";
import { defaultExecutionProfile } from "../../../src/domain/executionProfile.js";
import type { Task } from "../../../src/domain/task.js";
import { ExecutionManager, LocalExecutionDriver } from "../../../src/execution/manager.js";
import type { ProblemAnalysisResult } from "../../../src/problem/analyzer.js";
import { ScriptedProblemAnalyzer } from "../../../src/problem/application/analyzer.js";
import { ProblemService } from "../../../src/problem/application/service.js";
import { ConfirmationLoop } from "../../../src/problem/confirmationLoop.js";
import { ReviewService } from "../../../src/review/application/reviewService.js";
import { RunService } from "../../../src/run/application/runService.js";
import { TaskRunService } from "../../../src/run/application/taskRunService.js";
import { InMemoryConversationStore } from "../../../src/store/inMemoryConversationStore.js";
import { InMemoryEventStore } from "../../../src/store/inMemoryEventStore.js";
import { InMemoryExecutionStore } from "../../../src/store/inMemoryExecutionStore.js";
import { InMemoryProblemStore } from "../../../src/store/inMemoryProblemStore.js";
import { InMemoryRepositoryStore } from "../../../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../../../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../../../src/store/inMemoryTaskStore.js";
import { Verifier } from "../../../src/verification/runner.js";
import { Worker } from "../../../src/worker/worker.js";
import { WorkspaceManager } from "../../../src/workspace/manager.js";
import { createGitFixture, runGit, type GitFixture } from "../../helpers/gitFixture.js";

export const SAMPLE_PROJECT_DIR = join(
  process.cwd(),
  "tests/fixtures/sample-project",
);

/** The scripted "agent" implementation for the sample task. */
export const IMPLEMENTED_INDEX = [
  "function greet(name) {",
  "  return `Hello, ${name}!`;",
  "}",
  "",
  "module.exports = { greet };",
  "",
].join("\n");

export const SUFFICIENT_ANALYSIS: ProblemAnalysisResult = {
  summary: "problem is clear enough",
  needsInput: false,
  uncertainties: [],
  clarifications: [],
};

export function needsInputAnalysis(
  question = "Which behaviour is expected?",
): ProblemAnalysisResult {
  return {
    summary: "needs confirmation",
    needsInput: true,
    uncertainties: ["scope"],
    clarifications: [
      {
        question,
        type: "fact",
        required: true,
        options: [
          { id: "all_users", label: "All users" },
          { id: "some_users", label: "Some users" },
        ],
        reason: "determines scope",
      },
    ],
  };
}

/** Deterministic agent: writes the implemented module into every workdir. */
export class SampleAgentEngine implements AgentEngine {
  calls = 0;

  async execute(context: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    const exec = context.execution?.exec;
    if (!exec) {
      throw new Error("sample agent requires execution.exec");
    }
    const workdirs = Object.values(context.execution?.workdirs ?? {});
    for (const workdir of workdirs) {
      const result = await exec(
        ["sh", "-lc", `cat > src/index.js <<'EOF'\n${IMPLEMENTED_INDEX}EOF`],
        { cwd: workdir },
      );
      if (result.exitCode !== 0) {
        throw new Error(`sample agent write failed: ${result.stderr}`);
      }
    }
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: "sample agent implemented greet",
      stderr: "",
      startedAt: now,
      finishedAt: now,
    };
  }

  async cancel(): Promise<void> {}
}

class FailingAgentEngine implements AgentEngine {
  async execute(context: AgentContext): Promise<AgentResult> {
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 1,
      signal: undefined,
      stdout: "",
      stderr: "sample agent failed",
      startedAt: now,
      finishedAt: now,
    };
  }
  async cancel(): Promise<void> {}
}

export interface Phase11CommandInput {
  channel?: string;
  conversationId?: string;
  messageId: string;
  senderId?: string;
  command: unknown;
  roles?: Role[];
  text?: string;
}

export interface Phase11Harness {
  fixture: GitFixture;
  workspaceBase: string;
  engine: AgentEngine;
  problems: ProblemService;
  problemStore: InMemoryProblemStore;
  reviews: ReviewService;
  runService: RunService;
  taskRunService: TaskRunService;
  conversations: ConversationService;
  conversationStore: InMemoryConversationStore;
  repositories: InMemoryRepositoryStore;
  tasks: InMemoryTaskStore;
  runs: InMemoryRunStore;
  events: InMemoryEventStore;
  executions: InMemoryExecutionStore;
  executionManager: ExecutionManager;
  workspaceManager: WorkspaceManager;
  worker: Worker;
  dispatcher: CommandDispatcher;
  ingestion: FeishuEventIngestion;
  dispatchCommand(input: Phase11CommandInput): Promise<CommandResult>;
  dispatchFeishuEvent(
    input: Phase11CommandInput & { eventId: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  seedTask(options?: { status?: Task["status"]; title?: string }): Promise<Task>;
  feishuEventBody(messageId: string, eventId: string, text: string): string;
  cleanup(): void;
}

export async function createPhase11Harness(options: {
  analyses?: ProblemAnalysisResult[];
  engine?: AgentEngine;
  heartbeatMs?: number;
} = {}): Promise<Phase11Harness> {
  const fixture = createGitFixture();
  cpSync(SAMPLE_PROJECT_DIR, fixture.path, { recursive: true });
  runGit(["add", "."], fixture.path);
  runGit(["commit", "-m", "add sample-project fixture"], fixture.path);

  const workspaceBase = mkdtempSync(join(tmpdir(), "ai-phase11-"));
  const repositories = new InMemoryRepositoryStore();
  const tasks = new InMemoryTaskStore();
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const executions = new InMemoryExecutionStore();
  const problemStore = new InMemoryProblemStore();
  const conversationStore = new InMemoryConversationStore();

  await repositories.createRepository({
    id: "repo-sample",
    name: "sample-project",
    url: "git@github.com:example/sample-project.git",
    localPath: fixture.path,
    verificationCommands: ["node test/verify.js"],
    executionProfile: defaultExecutionProfile(),
  });

  const engine = options.engine ?? new SampleAgentEngine();
  const workspaceManager = new WorkspaceManager({ baseDir: workspaceBase });
  const executionManager = new ExecutionManager({
    driver: new LocalExecutionDriver(),
    executions,
    events,
  });
  const worker = new Worker({
    runStore: runs,
    taskStore: tasks,
    repositoryStore: repositories,
    workspaceManager,
    agentEngine: engine,
    verifier: new Verifier(),
    executionManager,
    eventStore: events,
    workerId: "worker-phase11",
    heartbeatMs: options.heartbeatMs ?? 25,
    leaseSeconds: 5,
  });

  const loop = new ConfirmationLoop({
    problems: problemStore,
    analyzer: new ScriptedProblemAnalyzer(options.analyses ?? [SUFFICIENT_ANALYSIS]),
    repositories,
    events,
  });
  const problems = new ProblemService(problemStore, loop);
  const conversations = new ConversationService(conversationStore);
  const reviews = new ReviewService({ tasks, runs, events });
  const runService = new RunService({ runs, tasks, events });
  const taskRunService = new TaskRunService({ tasks, runs, worker, repositories });

  const dispatcher = new CommandDispatcher({
    handlers: {
      ...createProblemCommandHandlers({ problems, conversations }),
      ...createTaskRunCommandHandlers({ taskRun: taskRunService, runs: runService }),
      ...createReviewCommandHandlers({ reviews }),
    },
    idempotency: new InMemoryIdempotencyStore(),
  });

  const pendingFeishuIntents = new Map<
    string,
    { command: unknown; roles: Role[] }
  >();
  const ingestion = new FeishuEventIngestion({
    conversation: conversations,
    onMessage: async (message, ctx) => {
      const pending = pendingFeishuIntents.get(message.messageId);
      if (!pending) {
        return;
      }
      await handleIntent(
        {
          channel: "feishu",
          conversationId: ctx.conversationId,
          messageId: message.messageId,
          senderId: message.senderId,
          text: message.text,
        },
        { channel: "feishu", userId: message.senderId, roles: pending.roles },
        { engine: new ScriptedIntentEngine({ command: pending.command }), dispatcher },
      );
    },
  });

  const dispatchCommand = async (
    input: Phase11CommandInput,
  ): Promise<CommandResult> =>
    handleIntent(
      {
        channel: input.channel ?? "cli",
        conversationId: input.conversationId ?? "conv-phase11",
        messageId: input.messageId,
        senderId: input.senderId ?? "cli-user",
        text: input.text ?? "command",
      },
      {
        channel: input.channel ?? "cli",
        userId: input.senderId ?? "cli-user",
        roles: input.roles ?? ["developer"],
      },
      { engine: new ScriptedIntentEngine({ command: input.command }), dispatcher },
    );

  const dispatchFeishuEvent = async (
    input: Phase11CommandInput & { eventId: string },
  ) => {
    pendingFeishuIntents.set(input.messageId, {
      command: input.command,
      roles: input.roles ?? ["developer"],
    });
    return ingestion.handleRequest({
      headers: {},
      body: feishuEventBody(input.messageId, input.eventId, input.text ?? "command"),
    });
  };

  const seedTask = async (seed: {
    status?: Task["status"];
    title?: string;
  } = {}): Promise<Task> =>
    tasks.createTask({
      id: "task-sample",
      repositoryId: "repo-sample",
      title: seed.title ?? "Implement greet",
      description: "Implement greet(name) in src/index.js.",
      acceptance: ["node test/verify.js passes"],
      status: seed.status ?? "READY",
      maxAttempts: 3,
    });

  return {
    fixture,
    workspaceBase,
    engine,
    problems,
    problemStore,
    reviews,
    runService,
    taskRunService,
    conversations,
    conversationStore,
    repositories,
    tasks,
    runs,
    events,
    executions,
    executionManager,
    workspaceManager,
    worker,
    dispatcher,
    ingestion,
    dispatchCommand,
    dispatchFeishuEvent,
    seedTask,
    feishuEventBody,
    cleanup: () => {
      fixture.cleanup();
      rmSync(workspaceBase, { recursive: true, force: true });
    },
  };
}

export function feishuEventBody(
  messageId: string,
  eventId: string,
  text: string,
): string {
  const template = JSON.parse(
    readFileSync(
      join(process.cwd(), "src/channel/feishu/fixtures/message.json"),
      "utf8",
    ),
  ) as {
    header: Record<string, unknown>;
    event: { message: Record<string, unknown> };
  };
  template.header.event_id = eventId;
  template.event.message.message_id = messageId;
  template.event.message.content = JSON.stringify({ text });
  return JSON.stringify(template);
}

export { FailingAgentEngine };
