import { renderDeliveryMessage } from "../../channel/rendering/delivery.js";
import type { DeliveryStatus } from "../../domain/delivery.js";
import type { DeliveryService, DeliveryTransition } from "./service.js";
import {
  isNotifiableDeliveryStatus,
  NoopDeliveryNotifier,
  type DeliveryNotification,
  type DeliveryNotifier,
} from "./notifier.js";

export interface DeliveryNotificationFailure {
  deliveryId: string;
  status: DeliveryStatus;
  reason: string;
}

export interface DeliveryReconciliationReport {
  /** Aggregate transitions observed in this pass. */
  transitions: DeliveryTransition[];
  /** Notifications actually delivered. */
  notified: number;
  /** Notifier failures — recorded, never rolling back a transition. */
  notificationFailures: DeliveryNotificationFailure[];
  /** Notifications still pending a retry from an earlier failure. */
  pendingNotifications: number;
  /** Notifications dropped because the pending queue was full (drop newest). */
  droppedNotifications: number;
}

export interface DeliveryReconcilerDeps {
  deliveries: DeliveryService;
  notifier?: DeliveryNotifier;
  /**
   * TASK-1207 Phase B bounds. Defaults are the production values; tests may
   * lower them to exercise the queue without generating 100 transitions.
   */
  capacity?: number;
  maxPerPass?: number;
}

export const NOTIFICATION_CAPACITY = 100;
export const NOTIFICATION_MAX_PER_PASS = 20;

/**
 * TASK-1206: Delivery Reconciliation.
 *
 *   Task facts → DeliveryService.reconcileAll() (single aggregation authority)
 *              → status transition (event already emitted by the service)
 *              → notification for READY_FOR_RELEASE / BLOCKED only
 *
 * The reconciler never releases, never merges, never touches Task status and
 * never re-implements aggregation. A notifier failure is recorded and retried
 * on the next pass (at-least-once); it can never roll back a persisted
 * transition, and the retry only re-sends the message (no duplicate
 * state-transition event).
 *
 * Pending queue (TASK-1207): FIFO, bounded, at most `maxPerPass` send attempts
 * per pass, overflow drops the **newest** notification and records it.
 */
export class DeliveryReconciler {
  private readonly notifier: DeliveryNotifier;
  private readonly capacity: number;
  private readonly maxPerPass: number;
  private pending: DeliveryNotification[] = [];

  constructor(private readonly deps: DeliveryReconcilerDeps) {
    this.notifier = deps.notifier ?? new NoopDeliveryNotifier();
    this.capacity = deps.capacity ?? NOTIFICATION_CAPACITY;
    this.maxPerPass = deps.maxPerPass ?? NOTIFICATION_MAX_PER_PASS;
  }

  async reconcileAll(): Promise<DeliveryReconciliationReport> {
    const failures: DeliveryNotificationFailure[] = [];
    const transitions = await this.deps.deliveries.reconcileAll();

    // FIFO: retries from earlier passes first, then this pass's transitions.
    const queue = [...this.pending];
    this.pending = [];
    for (const transition of transitions) {
      if (!isNotifiableDeliveryStatus(transition.status)) {
        continue;
      }
      queue.push(await this.buildNotification(transition));
    }

    let notified = 0;
    let attempted = 0;
    let droppedNotifications = 0;
    const keep: DeliveryNotification[] = [];
    for (const notification of queue) {
      if (attempted >= this.maxPerPass) {
        keep.push(notification);
        continue;
      }
      attempted += 1;
      try {
        await this.notifier.notify(notification);
        notified += 1;
      } catch (error) {
        failures.push(failureOf(notification, error));
        keep.push(notification);
      }
    }
    for (const notification of keep) {
      if (this.pending.length >= this.capacity) {
        // Drop newest: never evict an older message, FIFO must hold.
        droppedNotifications += 1;
        failures.push(
          failureOf(
            notification,
            new Error(`notification queue full (capacity ${this.capacity})`),
          ),
        );
        continue;
      }
      this.pending.push(notification);
    }

    return {
      transitions,
      notified,
      notificationFailures: failures,
      pendingNotifications: this.pending.length,
      droppedNotifications,
    };
  }

  private async buildNotification(
    transition: DeliveryTransition,
  ): Promise<DeliveryNotification> {
    const view = await this.deps.deliveries.load(transition.delivery.id);
    return {
      delivery: transition.delivery,
      previousStatus: transition.previousStatus,
      status: transition.status,
      message: renderDeliveryMessage({
        delivery: transition.delivery,
        tasks: view.tasks,
        blocking: view.blocking,
        release: view.release,
      }),
    };
  }
}

function failureOf(
  notification: DeliveryNotification,
  error: unknown,
): DeliveryNotificationFailure {
  return {
    deliveryId: notification.delivery.id,
    status: notification.status,
    reason: error instanceof Error ? error.message : String(error),
  };
}
