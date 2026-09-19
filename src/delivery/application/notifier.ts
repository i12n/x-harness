import type { OutgoingMessage } from "../../channel/message.js";
import type { Delivery, DeliveryStatus } from "../../domain/delivery.js";

/**
 * One delivery notification (TASK-1206). The message is already rendered from
 * facts by the reconciler; notifiers only deliver it, so the renderer never
 * decides *when* a notification happens.
 */
export interface DeliveryNotification {
  delivery: Delivery;
  previousStatus: DeliveryStatus;
  status: DeliveryStatus;
  message: OutgoingMessage;
}

/** Thin port: Feishu/DingTalk/Slack notifiers implement this later. */
export interface DeliveryNotifier {
  notify(notification: DeliveryNotification): Promise<void>;
}

/** Statuses a human actually needs to hear about. */
export function isNotifiableDeliveryStatus(status: DeliveryStatus): boolean {
  return status === "READY_FOR_RELEASE" || status === "BLOCKED";
}

export class NoopDeliveryNotifier implements DeliveryNotifier {
  async notify(): Promise<void> {
    // Intentionally empty: the default when no channel is wired.
  }
}

/** Test/offline notifier that records what would have been sent. */
export class RecordingDeliveryNotifier implements DeliveryNotifier {
  readonly notifications: DeliveryNotification[] = [];

  async notify(notification: DeliveryNotification): Promise<void> {
    this.notifications.push(notification);
  }

  /** Throws for the first `failures` notifications (TASK-1206 failure case). */
  static failingOnce(reason = "notifier unavailable"): RecordingDeliveryNotifier {
    const failing = new RecordingDeliveryNotifier();
    let failures = 1;
    failing.notify = async (notification: DeliveryNotification): Promise<void> => {
      if (failures > 0) {
        failures -= 1;
        throw new Error(reason);
      }
      failing.notifications.push(notification);
    };
    return failing;
  }
}
