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
import { TokenBudget } from "../loop/budget.js";
import { PreviewService } from "../preview/application/previewService.js";
import { previewSettingsFromEnv } from "../preview/application/previewSettings.js";
import { createPreviewCommandHandlers } from "../command/handlers/preview.js";
import { githubSettingsFromEnv } from "../github/githubSettings.js";
import { HttpGitHubClient } from "../github/httpGithubClient.js";
import { DeployService } from "../deploy/application/deployService.js";
import { GitBranchPublisher } from "../deploy/infrastructure/gitBranchPublisher.js";
import { createDeployCommandHandlers } from "../command/handlers/deploy.js";
import type { DeployCommandPort } from "../command/handlers/deploy.js";
import {
  detectCommandsFromDirectory,
  mergeDetectedCommands,
} from "../repository/application/commandDetection.js";
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
    const gitService = new GitService();
    const gitPublish = new GitPublishService({
      tasks: stores.tasks,
      runs: stores.runs,
      repositories: stores.repositories,
      git: gitService,
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

    // TASK-1229: one preview configuration for every repository.
    const previewSettings = previewSettingsFromEnv(process.env);
    const previewService = new PreviewService({
      deliveries: { load: (deliveryId) => deliveries.show(deliveryId) },
      repositories: stores.repositories,
      runs: stores.runs,
      executionManager,
      events: stores.events,
      allowedHosts: previewSettings.allowedHosts,
      memoryMb: previewSettings.memoryMb,
      cpus: previewSettings.cpus,
    });

    // TASK-1230: deployment is the repository's GitHub Actions' job. The harness
    // pushes the test branch, reads run state and merges after acceptance — it
    // never deploys and never holds a deployment credential. Off unless a
    // GitHub credential is configured (AI_GITHUB_APP_* or AI_GITHUB_TOKEN).
    const githubSettings = githubSettingsFromEnv(process.env);
    if (!githubSettings && (process.env.AI_GITHUB_APP_ID || process.env.AI_GITHUB_TOKEN)) {
      this.log(
        "GitHub 凭证已配置但不可用（App 私钥读不到？）——部署命令会被拒绝，其余功能不受影响",
      );
    }
    const deployService = githubSettings
      ? new DeployService({
          deliveries: { load: (deliveryId) => deliveries.show(deliveryId) },
          repositories: stores.repositories,
          runs: stores.runs,
          git: new GitBranchPublisher({
            tokenProvider: githubSettings.provider,
            allowedPrefixes: [
              ...new Set([
                ...(process.env.AI_GIT_PUSH_PREFIX ?? "ai/,test/")
                  .split(",")
                  .map((prefix) => prefix.trim())
                  .filter(Boolean),
                githubSettings.testBranchPrefix,
              ]),
            ],
          }),
          github: new HttpGitHubClient({
            tokenProvider: githubSettings.provider,
            ...(githubSettings.apiBase ? { apiBase: githubSettings.apiBase } : {}),
          }),
          events: stores.events,
          branchPrefix: githubSettings.testBranchPrefix,
          ...(envSeconds("AI_DEPLOY_WATCH_INTERVAL_SECONDS", 30) * 1000
            ? { watchIntervalMs: envSeconds("AI_DEPLOY_WATCH_INTERVAL_SECONDS", 30) * 1000 }
            : {}),
          ...(envMinutes("AI_DEPLOY_WATCH_TTL_MINUTES", 30) * 60_000
            ? { watchTtlMs: envMinutes("AI_DEPLOY_WATCH_TTL_MINUTES", 30) * 60_000 }
            : {}),
        })
      : undefined;
    const deploys: DeployCommandPort = deployService ?? githubNotConfigured();
    // TASK-1231: off by config → the loop never polls (only `部署状态` works).
    const deployWatcher =
      deployService && (process.env.AI_DEPLOY_WATCH ?? "on").toLowerCase() !== "off"
        ? deployService
        : undefined;

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
        ...createPreviewCommandHandlers({
          preview: previewService,
        }),
        ...createDeployCommandHandlers({ deploys }),
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
        // TASK-1215 (③): stop handing out work when the day's tokens are gone.
        budget: new TokenBudget({
          runs: stores.runs,
          events: stores.events,
          dailyTokenBudget: config.dailyTokenBudget,
        }),
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
      deployWatcher,
    });

    // TASK-1231: deployment feedback goes to the same place delivery
    // notifications do — the bound conversation when there is one, else the
    // configured default chat.
    const deployChatId = config.feishu.defaultChatId;
    // TASK-1231: where the test environment lives. GitHub owns the deploy, so
    // the harness cannot discover the URL by itself — it is configured once.
    const deployTestUrl = process.env.AI_DEPLOY_TEST_URL?.trim();
    const notifyDeployTransitions = async (transitions: unknown[]): Promise<void> => {
      if (!deployChatId || transitions.length === 0) {
        return;
      }
      const rows = transitions as { deliveryId: string; state: string; run?: { url?: string } }[];
      for (const row of rows) {
        const label =
          row.state === "succeeded"
            ? "✅ 测试环境就绪"
            : row.state === "failed"
              ? "❌ 部署失败"
              : row.state === "stale"
                ? "⏳ 部署超时，仍在进行"
                : "🔄 部署中";
        try {
          await sendToTarget(
            {
              conversationId: `deploy-${row.deliveryId}`,
              receiveId: deployChatId,
              receiveIdType: "chat_id",
            },
            {
              conversationId: row.deliveryId,
              text: [
                `${label}：${row.deliveryId}`,
                deployTestUrl ? `🧪 测试环境：${deployTestUrl}` : "",
                deployTestUrl
                  ? "打开链接即可验收（HTTP + IP + 端口，暂无鉴权）；数据为测试库，随部署更新。"
                  : "",
                row.run?.url ? `Workflow：${row.run.url}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
              metadata: { receiveId: deployChatId, receiveIdType: "chat_id" },
            },
          );
        } catch (error) {
          this.log(`部署通知发送失败：${describe(error)}`);
        }
      }
    };

    this.daemon = new LoopDaemon({
      loop,
      intervalMs: config.loopIntervalMs,
      afterTick: async (report) => {
        await notifyDeployTransitions(report.deployTransitions);
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
      // TASK-1226 follow-up: a checkout that declares nothing is not broken.
      // Fill the obvious commands once, then gate on the result.
      const detected = await detectCommandsFromDirectory(repository.localPath);
      const merged = mergeDetectedCommands(repository.executionProfile.commands, detected);
      const additions = (["install", "build", "test"] as const).filter(
        (key) => !repository.executionProfile.commands[key] && merged[key],
      );
      const verificationCommands =
        repository.verificationCommands.length === 0 && detected.verify
          ? [detected.verify]
          : repository.verificationCommands;
      let profile = repository.executionProfile;
      if (additions.length > 0 || verificationCommands !== repository.verificationCommands) {
        profile = { ...repository.executionProfile, commands: merged };
        try {
          await stores.repositories.updateRepository(repository.id, {
            ...(verificationCommands !== repository.verificationCommands
              ? { verificationCommands }
              : {}),
            executionProfile: profile,
          });
          this.log(
            `preflight: repository ${repository.id}: auto-filled ` +
              [
                ...additions.map((key) => `${key}=${merged[key]}`),
                ...(verificationCommands !== repository.verificationCommands
                  ? [`verify=${verificationCommands[0]}`]
                  : []),
              ].join(", "),
          );
        } catch (error) {
          this.log(
            `preflight: repository ${repository.id}: could not save detected commands: ${describe(error)}`,
          );
        }
      }
      const issues = await collectProfileIssues({
        repositoryId: repository.id,
        verificationCommands,
        profile,
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

/** Positive-number env override, else the default (used by TASK-1231 knobs). */
function envSeconds(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envMinutes(name: string, fallback: number): number {
  return envSeconds(name, fallback);
}

/**
 * TASK-1230: with no GitHub credential the deployment commands still exist, but
 * they say exactly what is missing instead of failing as an unknown command.
 */
function githubNotConfigured(): DeployCommandPort {
  const refusal = (): never => {
    throw new Error(
      "GitHub 未配置：请设置 AI_GITHUB_APP_ID + AI_GITHUB_APP_PRIVATE_KEY_PATH" +
        "（或回退用 AI_GITHUB_TOKEN），测试部署才能推送分支并读取 workflow 状态",
    );
  };
  return {
    deployTest: refusal as DeployCommandPort["deployTest"],
    status: refusal as DeployCommandPort["status"],
    promote: refusal as DeployCommandPort["promote"],
  };
}
