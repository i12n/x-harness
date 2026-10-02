import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { CodexEngine } from "../agent/codexEngine.js";
import { renderFeishuCard, renderFeishuText } from "../channel/feishu/cards.js";
import { parseCardAction } from "../channel/feishu/cardActions.js";
import { FeishuAdapter } from "../channel/feishu/adapter.js";
import { HttpFeishuClient } from "../channel/feishu/client.js";
import type { OutgoingMessage } from "../channel/message.js";
import { CommandDispatcher } from "../command/dispatcher.js";
import { createDeliveryCommandHandlers } from "../command/handlers/delivery.js";
import { createProblemCommandHandlers } from "../command/handlers/problem.js";
import { createReviewCommandHandlers } from "../command/handlers/review.js";
import { createSpecificationCommandHandlers } from "../command/handlers/specification.js";
import { createTaskRunCommandHandlers } from "../command/handlers/taskRun.js";
import { createConfigCommandHandlers } from "../command/handlers/config.js";
import { createGitCommandHandlers } from "../command/handlers/git.js";
import { createHistoryCommandHandlers } from "../command/handlers/history.js";
import { createChatHistoryPort } from "./deployment/chatHistoryPort.js";
import { createRepositoryCommandHandlers } from "../command/handlers/repository.js";
import { createRepositoryQueryPort } from "./deployment/repositoryPort.js";
import { createTaskListCommandHandlers } from "../command/handlers/taskList.js";
import { createTaskQueryPort } from "./deployment/taskQueryPort.js";
import { createQueryCommandHandlers } from "../command/handlers/queries.js";
import {
  createDeliveryQueryPort,
  createProblemQueryPort,
  createRunQueryPort,
} from "./deployment/queryPorts.js";
import { GitService } from "../git/gitService.js";
import { GitPublishService } from "../git/publishService.js";
import { InMemoryIdempotencyStore } from "../command/idempotency.js";
import { LlmIntentEngine } from "../command/llmIntentEngine.js";
import type { ConversationMessage } from "../domain/conversation.js";
import { ACTIVE_RUN_STATUSES } from "../domain/run.js";
import { HarnessError } from "../errors.js";
import { ConversationService } from "../conversation/service.js";
import { DeliveryReconciler } from "../delivery/application/reconciler.js";
import type { DeliveryNotifier } from "../delivery/application/notifier.js";
import { DeliveryService } from "../delivery/application/service.js";
import {
  ExecutionManager,
} from "../execution/manager.js";
import {
  codexSandboxFor,
  createExecutionDriver,
  parseExecutionDriverMode,
  workspacesDir,
} from "../execution/driverSelection.js";
import { HttpChatClient } from "../llm/chatClient.js";
import { Loop } from "../loop/loop.js";
import { LlmProblemAnalyzer } from "../problem/application/llmAnalyzer.js";
import { ProblemService } from "../problem/application/service.js";
import { ConfirmationLoop } from "../problem/confirmationLoop.js";
import { ReviewService } from "../review/application/reviewService.js";
import { RunService } from "../run/application/runService.js";
import { TaskRunService } from "../run/application/taskRunService.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { DeterministicTaskPlanner } from "../specification/application/planner.js";
import { PlanningService } from "../specification/application/planning.js";
import { SpecificationService } from "../specification/application/service.js";
import { openStores, type StoreHandle } from "../store/index.js";
import { TaskDependencyService } from "../task/application/dependencyService.js";
import { TaskIntakeService } from "../task/application/intakeService.js";
import { LlmReviewerAgent } from "../reviewer/application/reviewerAgent.js";
import { Verifier } from "../verification/runner.js";
import { Worker } from "../worker/worker.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { LoopDaemon } from "./daemon.js";
import { FeishuLongConnection } from "./feishuLongConnection.js";
import { CardRegistry } from "./cardRegistry.js";
import { checkLocalExecutionImage, type ImageChecker } from "../execution/imageCheck.js";
import { collectProfileIssues } from "../execution/profileGate.js";
import { RunChatNotifier, type ChatTarget } from "./notifications.js";
import { ChatSession } from "./session.js";
import { createIntentTriage } from "./intentTriage.js";
import { SpecificationBootstrap } from "./specificationBootstrap.js";
import { describeConversationSubject } from "./subjectContext.js";
import { createConfigAdminPort } from "./deployment/configPort.js";

export interface HarnessRuntimeOptions {
  config?: ServerConfig;
  log?: (message: string) => void;
}

/**
 * The deployment composition root: Harness Core (Loop/Scheduler/Worker) plus
 * the chat control plane (Feishu long connection → Conversation → Intent →
 * Command → Application), wired exactly once and owned by one process.
 */
export class HarnessRuntime {
  private readonly log: (message: string) => void;
  private readonly config: ServerConfig;
  private stores: StoreHandle | undefined;
  private daemon: LoopDaemon | undefined;
  private connection: FeishuLongConnection | undefined;
  private session: ChatSession | undefined;
  private stopped = false;

  constructor(options: HarnessRuntimeOptions = {}) {
    this.config = options.config ?? loadServerConfig();
    this.log = options.log ?? ((message) => console.log(`[ai-harness] ${message}`));
  }

  /** Builds the object graph, opens stores and starts the loop + receiver. */
  async start(): Promise<void> {
    const config = this.config;
    const stores = await openStores();
    this.stores = stores;

    const workspaceRoot = workspacesDir();
    const workspaceManager = new WorkspaceManager({ baseDir: workspaceRoot });
    const driver = createExecutionDriver({
      ...process.env,
      // The service config is authoritative over a stale inherited env.
      AI_EXECUTION_DRIVER: config.executionDriver,
    });
    const executionManager = new ExecutionManager({
      driver,
      executions: stores.executions,
      events: stores.events,
    });

    const driverMode = parseExecutionDriverMode(config.executionDriver);
    const sandbox = codexSandboxFor(driverMode, process.env);
    if (driverMode === "docker") {
      await this.preflightRepositories(stores);
    }
    // TASK-1221: the reviewer agent and the review transitions the Worker needs
    // are built here, before the Worker itself.
    const chat = new HttpChatClient(config.llm);
    const reviews = new ReviewService({
      tasks: stores.tasks,
      runs: stores.runs,
      events: stores.events,
    });
    const worker = new Worker({
      runStore: stores.runs,
      taskStore: stores.tasks,
      repositoryStore: stores.repositories,
      workspaceManager,
      agentEngine: new CodexEngine({ sandbox }),
      verifier: new Verifier(),
      executionManager,
      eventStore: stores.events,
      workerId: process.env.AI_WORKER_ID ?? "feishu-service",
      reviewer: config.reviewer === "off" ? undefined : new LlmReviewerAgent(chat),
      reviewerMode: config.reviewer,
      reviews,
    });

    const dependencies = new TaskDependencyService({
      tasks: stores.tasks,
      dependencies: stores.taskDependencies,
      events: stores.events,
    });

    // ---- chat transport -------------------------------------------------
    const conversations = new ConversationService(stores.conversations);
    const feishuClient = new HttpFeishuClient({
      credentials: { appId: config.feishu.appId, appSecret: config.feishu.appSecret },
    });
    const feishuAdapter = new FeishuAdapter({
      client: feishuClient,
      onThreadFallback: (error) =>
        this.log(`threaded reply failed, sent to the chat instead: ${describe(error)}`),
    });
    // Interactive cards are remembered by the id Feishu assigns them, so a
    // later button click can re-render the card and route the submit.
    const cards = new CardRegistry();

    // The bot's own open_id decides whether a group message addressed it.
    // Configured value wins; otherwise ask Feishu once at startup.
    let botOpenId = config.feishu.botOpenId;
    if (!botOpenId) {
      try {
        const bot = await feishuClient.getBotInfo();
        botOpenId = bot.openId;
        this.log(`bot identity: ${bot.name ?? "(unnamed)"} ${bot.openId}`);
      } catch (error) {
        this.log(
          `could not resolve the bot's open_id (${describe(error)}); ` +
            "any @mention will be treated as addressing the bot in groups",
        );
      }
    }

    const sendToTarget = async (
      target: ChatTarget,
      message: OutgoingMessage,
    ): Promise<void> => {
      const outgoing: OutgoingMessage = {
        ...message,
        conversationId: target.conversationId,
        metadata: {
          ...message.metadata,
          receiveId: target.receiveId,
          receiveIdType: target.receiveIdType ?? "chat_id",
        },
      };
      const sent = await feishuAdapter.sendWithResult(outgoing);
      if (sent?.messageId) {
        cards.register(sent.messageId, target, outgoing);
      }
      try {
        await conversations.recordOutgoing(target.conversationId, {
          text: renderFeishuText(outgoing),
          metadata: { receiveId: target.receiveId },
        });
      } catch (error) {
        this.log(`failed to record outgoing message: ${describe(error)}`);
      }
    };

    // ---- application services ------------------------------------------
    const problems = new ProblemService(
      stores.problems,
      new ConfirmationLoop({
        problems: stores.problems,
        repositories: stores.repositories,
        events: stores.events,
        analyzer: new LlmProblemAnalyzer(chat),
      }),
    );
    const gitPublish = new GitPublishService({
      tasks: stores.tasks,
      runs: stores.runs,
      repositories: stores.repositories,
      git: new GitService(),
      events: stores.events,
    });
    const runs = new RunService({ runs: stores.runs, tasks: stores.tasks, events: stores.events });

    const deliveries = new DeliveryService({
      deliveries: stores.deliveries,
      plans: stores.specificationPlans,
      tasks: stores.tasks,
      events: stores.events,
      impacts: dependencies,
      runs: stores.runs,
    });
    const planning = new PlanningService({
      specifications: stores.specifications,
      plans: stores.specificationPlans,
      tasks: stores.tasks,
      planner: new DeterministicTaskPlanner(),
      events: stores.events,
      deliveries,
      // TASK-1219: planning ends with READY tasks, so the Scheduler starts
      // them on the next tick. AI_AUTO_START=off restores manual intake.
      intake: config.autoStart
        ? new TaskIntakeService({
            tasks: stores.tasks,
            repositories: stores.repositories,
            events: stores.events,
          })
        : undefined,
    });
    const specifications = new SpecificationService({
      specifications: stores.specifications,
      problems: stores.problems,
      events: stores.events,
    });

    // Chat runs are queued, never executed inline: the Loop owns execution.
    const taskRun = new TaskRunService({
      tasks: stores.tasks,
      runs: stores.runs,
      worker,
      repositories: stores.repositories,
      dependencies,
      runMode: "enqueue",
    });

    const taskQueries = createTaskQueryPort({
      tasks: stores.tasks,
      repositories: stores.repositories,
    });

    const dispatcher = new CommandDispatcher({
      handlers: {
        ...createProblemCommandHandlers({ problems, conversations }),
        ...createTaskRunCommandHandlers({ taskRun, runs }),
        ...createReviewCommandHandlers({
          reviews,
          tasks: taskQueries,
          publish: (taskId) => gitPublish.publishTask(taskId),
        }),
        ...createGitCommandHandlers({
          publish: (taskId) => gitPublish.publishTask(taskId),
        }),
        ...createSpecificationCommandHandlers({ planning, specification: specifications }),
        ...createDeliveryCommandHandlers({ deliveries, runs: stores.runs }),
        ...createConfigCommandHandlers({
          config: createConfigAdminPort({
            envFile: config.configFile,
            events: stores.events,
          }),
        }),
        ...createHistoryCommandHandlers({
          history: createChatHistoryPort({ conversations: stores.conversations }),
        }),
        ...createRepositoryCommandHandlers({
          repositories: createRepositoryQueryPort({ repositories: stores.repositories }),
        }),
        ...createTaskListCommandHandlers({
          tasks: taskQueries,
        }),
        ...createQueryCommandHandlers({
          runs: createRunQueryPort({ runs: stores.runs, tasks: stores.tasks }),
          problems: createProblemQueryPort({ problems: stores.problems }),
          deliveries: createDeliveryQueryPort({
            deliveries: stores.deliveries,
            specifications: stores.specifications,
            service: deliveries,
          }),
        }),
      },
      idempotency: new InMemoryIdempotencyStore(),
    });

    const notifier = new RunChatNotifier({
      runs: stores.runs,
      events: stores.events,
      send: sendToTarget,
    });

    const intent = new LlmIntentEngine({
      client: chat,
      defaultRepositoryId: config.defaultRepositoryId,
      extraInstructions: config.intentNotes,
      context: async (input) => {
        try {
          const conversation = await conversations.findConversation(input.conversationId);
          const messages = await conversations.context(input.conversationId, { limit: 12 });
          const subject = await describeConversationSubject(conversation, {
            problems: stores.problems,
            tasks: stores.tasks,
            runs: stores.runs,
          });
          return [
            ...subject,
            ...messages
              .filter((message) => message.externalMessageId !== input.messageId)
              .map(renderContextLine),
          ];
        } catch {
          return [];
        }
      },
    });

    const session = new ChatSession({
      conversations,
      intent,
      triage: createIntentTriage({ engine: intent }),
      dispatcher,
      access: config.access,
      botOpenId,
      threadReplies: config.feishu.threadReplies,
      send: sendToTarget,
      cards,
      notifier,
      specificationBootstrap: config.autoBootstrapSpecification
        ? new SpecificationBootstrap({
            problems: stores.problems,
            repositories: stores.repositories,
            specifications: stores.specifications,
            specificationPlans: stores.specificationPlans,
            tasks: stores.tasks,
            specificationService: specifications,
            planning,
            chat,
          })
        : undefined,
      restartService,
      log: (message) => this.log(message),
      recordEvent: async (type, payload) => {
        await stores.events.record({ type, payload });
      },
    });
    this.session = session;

    // ---- delivery notifications ----------------------------------------
    const deliveryNotifier: DeliveryNotifier = {
      notify: async (notification) => {
        if (!config.feishu.defaultChatId) {
          return;
        }
        // Resolve the *internal* conversation for the notification chat, so
        // delivery messages are recorded in the history like every other
        // outbound message (they used to be sent but never persisted).
        const conversation = await conversations.getOrCreate({
          channel: "feishu",
          externalChatId: config.feishu.defaultChatId,
        });
        await sendToTarget(
          {
            conversationId: conversation.id,
            receiveId: config.feishu.defaultChatId,
            receiveIdType: "chat_id",
          },
          notification.message,
        );
      },
    };

    // ---- execution loop -------------------------------------------------
    const loop = new Loop({
      scheduler: new Scheduler({
        taskStore: stores.tasks,
        runStore: stores.runs,
        eventStore: stores.events,
        maxConcurrency: config.maxConcurrency,
        runnableTasks: dependencies,
      }),
      worker,
      runStore: stores.runs,
      taskStore: stores.tasks,
      eventStore: stores.events,
      executions: stores.executions,
      executionManager,
      repositories: stores.repositories,
      workspaceManager,
      maxConcurrency: config.maxConcurrency,
      deliveryReconciler: new DeliveryReconciler({
        deliveries,
        notifier: deliveryNotifier,
      }),
    });

    this.daemon = new LoopDaemon({
      loop,
      intervalMs: config.loopIntervalMs,
      afterTick: async () => {
        await notifier.flush();
      },
      log: (message) => this.log(message),
      onError: (error) => this.log(`loop error: ${describe(error)}`),
    });
    this.daemon.start();

    this.connection = new FeishuLongConnection({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      onEvent: (envelope) => session.handleEvent(envelope),
      onCardAction: async (body) => {
        const action = parseCardAction(body);
        if (!action) {
          this.log("card action: could not parse the callback body");
          // Cannot be routed, but it still must be answered with a card so the
          // client does not surface the callback error.
          return renderFeishuCard({
            conversationId: "card",
            text: "⚠️ 无法识别这次卡片操作，请重新发送指令。",
          });
        }
        this.log(
          `card action received: ${action.actionId} by ${action.operatorOpenId} on ${action.messageId}`,
        );
        const outcome = await session.handleCardAction(action);
        if (outcome.deferred) {
          // Ack first: the callback must answer inside Feishu's ~3s budget, and
          // the follow-up work can call a model.
          void outcome.deferred().catch((error: unknown) => {
            this.log(`card action follow-up failed: ${describe(error)}`);
          });
        }
        const response = renderFeishuCard(outcome.immediate);
        this.log(
          `card action answered: ${action.actionId} (${
            outcome.deferred ? "deferred" : "sync"
          }, ${JSON.stringify(response).length} bytes)`,
        );
        return response;
      },
      log: (message) => this.log(message),
      errorLog: (message) => this.log(message),
    });
    await this.connection.start();

    this.log(
      `service started (driver=${config.executionDriver}, loop=${config.loopIntervalMs}ms, ` +
        `agent-sandbox=${sandbox}, workspaces=${workspaceRoot})`,
    );
  }

  /**
   * TASK-1217/1218: report every registered repository whose profile would make
   * its Runs fail — missing image, no verification commands, unresolvable
   * secret, no network for the agent. All of these used to surface only when a
   * Run was already failing. Warning only: the service still starts.
   */
  private async preflightRepositories(stores: StoreHandle): Promise<void> {
    let repositories;
    try {
      repositories = await stores.repositories.listRepositories();
    } catch (error) {
      this.log(`preflight: could not list repositories: ${describe(error)}`);
      return;
    }
    const images = new Map<string, Awaited<ReturnType<ImageChecker>>>();
    const checkImage: ImageChecker = async (image) => {
      const cached = images.get(image);
      if (cached) {
        return cached;
      }
      const result = await checkLocalExecutionImage(image);
      images.set(image, result);
      return result;
    };
    for (const repository of repositories) {
      const issues = await collectProfileIssues({
        repositoryId: repository.id,
        verificationCommands: repository.verificationCommands,
        profile: repository.executionProfile,
        env: process.env,
        checkImage,
      });
      for (const issue of issues) {
        this.log(`preflight: repository ${repository.id}: ${issue.message} [${issue.code}]`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.connection?.stop();
    await this.daemon?.stop();
    if (this.stores) {
      await this.stores.close();
    }
    this.log("service stopped");
  }

  /** Exposed for tests. */
  get chatSession(): ChatSession | undefined {
    return this.session;
  }
}

/**
 * Restarts the systemd unit. It answers the HTTP request first (the delay lets
 * the response flush) because the restart terminates this very process — and
 * refuses to pretend to restart when the service is not systemd-managed.
 */
async function restartService(): Promise<void> {
  if (!process.env.INVOCATION_ID) {
    throw new HarnessError(
      "service is not managed by systemd (no INVOCATION_ID) — restart it manually",
    );
  }
  await new Promise<void>((resolvePromise, reject) => {
    setTimeout(() => {
      try {
        spawn("systemctl", ["restart", "ai-harness"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        resolvePromise();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, 500);
  });
}

export async function runHarnessService(
  options: HarnessRuntimeOptions = {},
): Promise<void> {
  const runtime = new HarnessRuntime(options);
  await runtime.start();

  const shutdown = (signal: string): void => {
    runtime
      .stop()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`[ai-harness] shutdown after ${signal} failed: ${describe(error)}`);
        process.exit(1);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function renderContextLine(message: ConversationMessage): string {
  const speaker = message.direction === "INBOUND" ? "user" : "harness";
  return `${speaker}: ${truncate(message.content, 600)}`;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
