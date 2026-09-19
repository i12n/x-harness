import { buildDelivery, buildRelease } from "../domain/delivery.js";
import type {
  CreateDeliveryInput,
  CreateReleaseInput,
  Delivery,
  DeliveryStatus,
  Release,
} from "../domain/delivery.js";
import {
  DeliveryNotFoundError,
  DuplicateDeliveryError,
  ValidationError,
} from "../errors.js";
import type { DeliveryListFilter, DeliveryStore } from "./deliveryStore.js";

/** Non-persistent delivery/release store, used by tests and memory mode. */
export class InMemoryDeliveryStore implements DeliveryStore {
  private readonly deliveries = new Map<string, Delivery>();
  private readonly releases = new Map<string, Release>();

  async createDelivery(input: CreateDeliveryInput): Promise<Delivery> {
    const delivery = buildDelivery(input);
    if (this.deliveries.has(delivery.id)) {
      throw new DuplicateDeliveryError(delivery.id);
    }
    if (
      [...this.deliveries.values()].some(
        (existing) => existing.specificationId === delivery.specificationId,
      )
    ) {
      throw new ValidationError(
        `specification ${delivery.specificationId} already has a delivery`,
      );
    }
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }

  async findDelivery(id: string): Promise<Delivery> {
    const delivery = this.deliveries.get(id);
    if (!delivery) {
      throw new DeliveryNotFoundError(id);
    }
    return delivery;
  }

  async findDeliveryBySpecification(
    specificationId: string,
  ): Promise<Delivery | undefined> {
    return [...this.deliveries.values()].find(
      (delivery) => delivery.specificationId === specificationId,
    );
  }

  async listDeliveries(filter: DeliveryListFilter = {}): Promise<Delivery[]> {
    return [...this.deliveries.values()]
      .filter(
        (delivery) =>
          (filter.specificationId === undefined ||
            delivery.specificationId === filter.specificationId) &&
          (filter.status === undefined || delivery.status === filter.status),
      )
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }

  async updateDeliveryStatus(id: string, status: DeliveryStatus): Promise<Delivery> {
    const current = await this.findDelivery(id);
    const updated: Delivery = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.deliveries.set(id, updated);
    return updated;
  }

  async updateDeliveryStatusIf(
    id: string,
    expected: DeliveryStatus,
    status: DeliveryStatus,
  ): Promise<Delivery | undefined> {
    const current = await this.findDelivery(id);
    if (current.status !== expected) {
      return undefined;
    }
    return this.updateDeliveryStatus(id, status);
  }

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    const release = buildRelease(input);
    if (this.releases.has(release.id)) {
      throw new ValidationError(`release already exists: ${release.id}`);
    }
    if (
      release.status === "RELEASED" &&
      [...this.releases.values()].some(
        (existing) =>
          existing.deliveryId === release.deliveryId &&
          existing.status === "RELEASED",
      )
    ) {
      throw new ValidationError(`delivery ${release.deliveryId} is already released`);
    }
    this.releases.set(release.id, release);
    return release;
  }

  async listReleases(deliveryId: string): Promise<Release[]> {
    return [...this.releases.values()]
      .filter((release) => release.deliveryId === deliveryId)
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }

  async findReleasedRelease(deliveryId: string): Promise<Release | undefined> {
    return [...this.releases.values()].find(
      (release) => release.deliveryId === deliveryId && release.status === "RELEASED",
    );
  }
}
