import type {
  CreateDeliveryInput,
  CreateReleaseInput,
  Delivery,
  DeliveryStatus,
  Release,
} from "../domain/delivery.js";

export interface DeliveryListFilter {
  specificationId?: string;
  status?: DeliveryStatus;
}

/**
 * Persistence contract for `deliveries` + `releases` (Phase 12 / TASK-1205).
 * Uniqueness (one Delivery per Specification, one RELEASED release per
 * Delivery) is enforced by the schema; the store surfaces conflicts as
 * domain errors.
 */
export interface DeliveryStore {
  createDelivery(input: CreateDeliveryInput): Promise<Delivery>;
  findDelivery(id: string): Promise<Delivery>;
  /** The single Delivery of a Specification, if it exists. */
  findDeliveryBySpecification(
    specificationId: string,
  ): Promise<Delivery | undefined>;
  listDeliveries(filter?: DeliveryListFilter): Promise<Delivery[]>;
  updateDeliveryStatus(id: string, status: DeliveryStatus): Promise<Delivery>;
  /**
   * Compare-and-set status; `undefined` when the Delivery is not in
   * `expected` (another process already moved it).
   */
  updateDeliveryStatusIf(
    id: string,
    expected: DeliveryStatus,
    status: DeliveryStatus,
  ): Promise<Delivery | undefined>;

  createRelease(input: CreateReleaseInput): Promise<Release>;
  listReleases(deliveryId: string): Promise<Release[]>;
  /** The RELEASED record of a Delivery, if it was already released. */
  findReleasedRelease(deliveryId: string): Promise<Release | undefined>;
}
