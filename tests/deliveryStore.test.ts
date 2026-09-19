import { describe, expect, it } from "vitest";
import {
  DeliveryNotFoundError,
  DuplicateDeliveryError,
  ValidationError,
} from "../src/errors.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";

describe("InMemoryDeliveryStore (TASK-1205)", () => {
  it("keeps one delivery per specification", async () => {
    const store = new InMemoryDeliveryStore();
    const delivery = await store.createDelivery({
      id: "dlv-001",
      specificationId: "spec-001",
    });
    expect(delivery.status).toBe("PLANNED");

    await expect(
      store.createDelivery({ id: "dlv-002", specificationId: "spec-001" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.createDelivery({ id: "dlv-001", specificationId: "spec-002" }),
    ).rejects.toBeInstanceOf(DuplicateDeliveryError);

    await expect(store.findDeliveryBySpecification("spec-001")).resolves.toMatchObject({
      id: "dlv-001",
    });
    await expect(store.findDeliveryBySpecification("spec-missing")).resolves.toBeUndefined();
    await expect(store.findDelivery("dlv-missing")).rejects.toBeInstanceOf(
      DeliveryNotFoundError,
    );
  });

  it("updates status, supports compare-and-set and filters lists", async () => {
    const store = new InMemoryDeliveryStore();
    await store.createDelivery({ id: "dlv-001", specificationId: "spec-001" });
    await store.createDelivery({
      id: "dlv-002",
      specificationId: "spec-002",
      status: "READY_FOR_RELEASE",
    });

    const updated = await store.updateDeliveryStatus("dlv-001", "IN_PROGRESS");
    expect(updated.status).toBe("IN_PROGRESS");

    await expect(
      store.updateDeliveryStatusIf("dlv-001", "READY_FOR_RELEASE", "RELEASED"),
    ).resolves.toBeUndefined();
    await expect(
      store.updateDeliveryStatusIf("dlv-002", "READY_FOR_RELEASE", "RELEASED"),
    ).resolves.toMatchObject({ id: "dlv-002", status: "RELEASED" });

    await expect(store.listDeliveries({ status: "RELEASED" })).resolves.toMatchObject([
      { id: "dlv-002" },
    ]);
    await expect(store.listDeliveries({ specificationId: "spec-001" })).resolves.toMatchObject([
      { id: "dlv-001" },
    ]);
    await expect(store.updateDeliveryStatus("dlv-missing", "RELEASED")).rejects.toBeInstanceOf(
      DeliveryNotFoundError,
    );
  });

  it("allows one RELEASED release per delivery and keeps history", async () => {
    const store = new InMemoryDeliveryStore();
    await store.createDelivery({ id: "dlv-001", specificationId: "spec-001" });

    const pending = await store.createRelease({ id: "rel-000", deliveryId: "dlv-001" });
    expect(pending).toMatchObject({ status: "PENDING", releasedAt: undefined });

    const released = await store.createRelease({
      id: "rel-001",
      deliveryId: "dlv-001",
      status: "RELEASED",
      createdBy: "cli:reviewer",
    });
    expect(released.status).toBe("RELEASED");
    expect(released.releasedAt).toBeDefined();

    await expect(
      store.createRelease({ id: "rel-002", deliveryId: "dlv-001", status: "RELEASED" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.createRelease({ id: "rel-003", deliveryId: "dlv-001", status: "CANCELLED" }),
    ).resolves.toMatchObject({ status: "CANCELLED" });

    await expect(store.findReleasedRelease("dlv-001")).resolves.toMatchObject({
      id: "rel-001",
    });
    await expect(store.listReleases("dlv-001")).resolves.toHaveLength(3);
    await expect(store.findReleasedRelease("dlv-002")).resolves.toBeUndefined();
  });
});
