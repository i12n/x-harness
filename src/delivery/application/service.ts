import {
  aggregateDeliveryStatus,
  blockingTasks,
  buildRelease,
  isRequiredTask,
} from "../../domain/delivery.js";
import type { Delivery, DeliveryStatus, Release } from "../../domain/delivery.js";
import type { Task } from "../../domain/task.js";
import { HarnessError } from "../../errors.js";
import type { DeliveryStore } from "../../store/deliveryStore.js";
import type { EventStore } from "../../store/eventStore.js";
import type { SpecificationPlanStore } from "../../store/specificationPlanStore.js";
import type { TaskStore } from "../../store/taskStore.js";

/** Domain rejections of the delivery/release lifecycle. */
export class DeliveryError extends HarnessError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
  }
}

export interface DeliveryServiceDeps {
  deliveries: DeliveryStore;
  plans: SpecificationPlanStore;
  tasks: TaskStore;
  events?: EventStore;
}

/** Aggregated view of a Delivery: facts only, no rendering. */
export interface DeliveryView {
  delivery: Delivery;
  specificationId: string;
  tasks: Task[];
  requiredTasks: Task[];
  optionalTasks: Task[];
  blocking: Task[];
  release?: Release;
}

export interface ReleaseOutcome {
  delivery: Delivery;
  release: Release;
  /** False when the Delivery was already released (idempotent re-release). */
  created: boolean;
}

/** One observed aggregate transition (TASK-1206 reconciler input). */
export interface DeliveryTransition {
  delivery: Delivery;
  previousStatus: DeliveryStatus;
  status: DeliveryStatus;
}

/**
 * TASK-1205: Delivery aggregation + Release records.
 *
 *   Specification 1:1 Delivery 1:N Release
 *
 * `refresh()` recomputes the status from *current* Task facts (required-only
 * aggregation) and persists the transition so it is observable, but the
 * aggregate is never an independent source of truth: every read recomputes.
 * Nothing here publishes, pushes, merges or deploys.
 */
export class DeliveryService {
  constructor(private readonly deps: DeliveryServiceDeps) {}

  /** Idempotent: one Delivery per Specification (schema-enforced). */
  async createForSpecification(specificationId: string): Promise<Delivery> {
    const existing = await this.deps.deliveries.findDeliveryBySpecification(
      specificationId,
    );
    if (existing) {
      return existing;
    }
    let delivery: Delivery;
    try {
      delivery = await this.deps.deliveries.createDelivery({ specificationId });
    } catch (error) {
      // Lost a race with another planner: the Delivery exists either way.
      const raced = await this.deps.deliveries.findDeliveryBySpecification(
        specificationId,
      );
      if (raced) {
        return raced;
      }
      throw error;
    }
    await this.emit("delivery.created", delivery, {});
    return delivery;
  }

  /** Recompute the aggregate from current Task facts and persist transitions. */
  async refresh(deliveryId: string): Promise<DeliveryView> {
    const { view } = await this.aggregate(deliveryId);
    return view;
  }

  /**
   * TASK-1206: one reconciliation pass for a Delivery. Returns the transition
   * when the aggregate moved, otherwise `undefined` (no event, no side effect).
   */
  async reconcile(deliveryId: string): Promise<DeliveryTransition | undefined> {
    const { transition } = await this.aggregate(deliveryId);
    return transition;
  }

  /** Reconciliation over every Delivery (the loop's entry point). */
  async reconcileAll(): Promise<DeliveryTransition[]> {
    const deliveries = await this.deps.deliveries.listDeliveries();
    const transitions: DeliveryTransition[] = [];
    for (const delivery of deliveries) {
      const transition = await this.reconcile(delivery.id);
      if (transition) {
        transitions.push(transition);
      }
    }
    return transitions;
  }

  private async aggregate(
    deliveryId: string,
  ): Promise<{ view: DeliveryView; transition?: DeliveryTransition }> {
    const view = await this.load(deliveryId);
    const computed = aggregateDeliveryStatus(view.tasks);
    const current = view.delivery.status;
    // RELEASED is a human action, not an aggregate: it stays until superseded.
    if (current === "RELEASED" || current === computed) {
      return { view };
    }
    const updated = await this.deps.deliveries.updateDeliveryStatus(
      deliveryId,
      computed,
    );
    await this.emitTransition(updated, computed, view.blocking);
    return {
      view: { ...view, delivery: updated },
      transition: {
        delivery: updated,
        previousStatus: current,
        status: computed,
      },
    };
  }

  /** Aggregated, freshly computed view (never mutates Tasks). */
  async show(deliveryId: string): Promise<DeliveryView> {
    return this.refresh(deliveryId);
  }

  async findBySpecification(
    specificationId: string,
  ): Promise<Delivery | undefined> {
    return this.deps.deliveries.findDeliveryBySpecification(specificationId);
  }

  /**
   * Human release: records the release and marks the Delivery RELEASED.
   * Refuses anything that is not READY_FOR_RELEASE, and is idempotent.
   */
  async release(
    deliveryId: string,
    actor: { channel: string; userId: string },
  ): Promise<ReleaseOutcome> {
    const view = await this.refresh(deliveryId);
    const actorLabel = `${actor.channel}:${actor.userId}`;

    if (view.delivery.status === "RELEASED") {
      const existing = await this.deps.deliveries.findReleasedRelease(deliveryId);
      if (existing) {
        return { delivery: view.delivery, release: existing, created: false };
      }
    }
    if (view.delivery.status !== "READY_FOR_RELEASE") {
      throw new DeliveryError(
        "delivery_not_ready_for_release",
        `delivery ${deliveryId} is ${view.delivery.status}; ` +
          "all required tasks must be DONE before a release",
      );
    }

    // Compare-and-set first: only one caller turns READY_FOR_RELEASE into
    // RELEASED, so a race cannot produce two RELEASED records.
    const claimed = await this.deps.deliveries.updateDeliveryStatusIf(
      deliveryId,
      "READY_FOR_RELEASE",
      "RELEASED",
    );
    if (!claimed) {
      const raced = await this.deps.deliveries.findReleasedRelease(deliveryId);
      if (raced) {
        return {
          delivery: await this.deps.deliveries.findDelivery(deliveryId),
          release: raced,
          created: false,
        };
      }
      throw new DeliveryError(
        "delivery_not_ready_for_release",
        `delivery ${deliveryId} could not be claimed for release`,
      );
    }

    const release = await this.deps.deliveries.createRelease(
      buildRelease({
        deliveryId,
        status: "RELEASED",
        createdBy: actorLabel,
      }),
    );
    await this.emit("release.created", claimed, {
      releaseId: release.id,
      createdBy: actorLabel,
    });
    await this.emit("release.released", claimed, {
      releaseId: release.id,
      createdBy: actorLabel,
    });
    return { delivery: claimed, release, created: true };
  }

  /** Task facts of the Specification's plan (required/optional/blocking). */
  async load(deliveryId: string): Promise<DeliveryView> {
    const delivery = await this.deps.deliveries.findDelivery(deliveryId);
    const tasks: Task[] = [];
    const planItems = await this.deps.plans.listPlanItems(delivery.specificationId);
    for (const item of planItems) {
      if (!item.taskId) {
        continue;
      }
      tasks.push(await this.deps.tasks.findTask(item.taskId));
    }
    return {
      delivery,
      specificationId: delivery.specificationId,
      tasks,
      requiredTasks: tasks.filter((task) => isRequiredTask(task)),
      optionalTasks: tasks.filter((task) => !isRequiredTask(task)),
      blocking: blockingTasks(tasks),
      release: await this.deps.deliveries.findReleasedRelease(deliveryId),
    };
  }

  private async emitTransition(
    delivery: Delivery,
    computed: DeliveryStatus,
    blocking: Task[],
  ): Promise<void> {
    if (computed === "READY_FOR_RELEASE") {
      await this.emit("delivery.ready_for_release", delivery, {
        tasks: await this.taskIds(delivery),
      });
      return;
    }
    if (computed === "BLOCKED") {
      await this.emit("delivery.blocked", delivery, {
        blocking: blocking.map((task) => ({ id: task.id, status: task.status })),
      });
      return;
    }
    if (computed === "IN_PROGRESS") {
      await this.emit("delivery.in_progress", delivery, {
        tasks: await this.taskIds(delivery),
      });
    }
  }

  private async taskIds(delivery: Delivery): Promise<string[]> {
    const items = await this.deps.plans.listPlanItems(delivery.specificationId);
    return items
      .map((item) => item.taskId)
      .filter((taskId): taskId is string => Boolean(taskId));
  }

  private async emit(
    type: string,
    delivery: Delivery,
    payload: unknown,
  ): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    try {
      await this.deps.events.record({
        type,
        payload: {
          deliveryId: delivery.id,
          specificationId: delivery.specificationId,
          status: delivery.status,
          ...(payload as object),
        },
      });
    } catch {
      // History must never break delivery aggregation.
    }
  }
}
