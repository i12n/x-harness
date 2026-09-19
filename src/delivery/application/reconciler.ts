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
}

export interface DeliveryReconcilerDeps {
  deliveries: DeliveryService;
  notifier?: DeliveryNotifier;
}

const MAX_PENDING_NOTIFICATIONS = 50;

/**
 * TASK-1206: Delivery Reconciliation.
 *
 *   Task facts → DeliveryService.reconcileAll() (single aggregation authority)
 *              → status transition (event already emitted by the service)
 *              → notification for READY_FOR_RELEASE / BLOCKED only
 *
 * The reconciler never releases, never merges, never touches Task status and
 * never re-implements aggregation. A notifier failure is recorded and retried
 * on the next pass; it can never roll back a persisted transition, and the
 * retry only re-sends the message (no duplicate state-transition event).
 */
export class DeliveryReconciler {
  private readonly notifier: DeliveryNotifier;
  private pending: DeliveryNotification[] = [];

  constructor(private readonly deps: DeliveryReconcilerDeps) {
    this.notifier = deps.notifier ?? new NoopDeliveryNotifier();
  }

  async reconcileAll(): Promise<DeliveryReconciliationReport> {
    const failures: DeliveryNotificationFailure[] = [];
    let notified = 0;

    // 1. Retry notifications that failed earlier (status events stay as-is).
    const retries = this.pending;
    this.pending = [];
    for (const notification of retries) {
      if (await this.deliver(notification, failures)) {
        notified += 1;
      }
    }

    // 2. Aggregate every Delivery and notify real transitions.
    const transitions = await this.deps.deliveries.reconcileAll();
    for (const transition of transitions) {
      if (!isNotifiableDeliveryStatus(transition.status)) {
        continue;
      }
      const view = await this.deps.deliveries.load(transition.delivery.id);
      const notification: DeliveryNotification = {
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
      if (await this.deliver(notification, failures)) {
        notified += 1;
      }
    }

    return {
      transitions,
      notified,
      notificationFailures: failures,
      pendingNotifications: this.pending.length,
    };
  }

  private async deliver(
    notification: DeliveryNotification,
    failures: DeliveryNotificationFailure[],
  ): Promise<boolean> {
    try {
      await this.notifier.notify(notification);
      return true;
    } catch (error) {
      failures.push({
        deliveryId: notification.delivery.id,
        status: notification.status,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (this.pending.length < MAX_PENDING_NOTIFICATIONS) {
        this.pending.push(notification);
      }
      return false;
    }
  }
}
