import { buildSpecificationPlanItem } from "../domain/specificationPlan.js";
import type {
  CreateSpecificationPlanItemInput,
  SpecificationPlanItem,
} from "../domain/specificationPlan.js";
import { ValidationError } from "../errors.js";
import type { SpecificationPlanStore } from "./specificationPlanStore.js";

/** Non-persistent plan store, used by tests and memory-mode demos. */
export class InMemorySpecificationPlanStore implements SpecificationPlanStore {
  private readonly items = new Map<string, SpecificationPlanItem>();

  async listPlanItems(specificationId: string): Promise<SpecificationPlanItem[]> {
    return [...this.items.values()]
      .filter((item) => item.specificationId === specificationId)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  async createPlanItem(
    input: CreateSpecificationPlanItemInput,
  ): Promise<SpecificationPlanItem> {
    const item = buildSpecificationPlanItem(input);
    const existing = await this.listPlanItems(item.specificationId);
    if (existing.some((entry) => entry.id === item.id)) {
      throw new ValidationError(`plan item already exists: ${item.id}`);
    }
    if (existing.some((entry) => entry.position === item.position)) {
      throw new ValidationError(
        `specification ${item.specificationId} already has a plan item at position ${item.position}`,
      );
    }
    if (item.taskId && [...this.items.values()].some((e) => e.taskId === item.taskId)) {
      throw new ValidationError(`plan item task already linked: ${item.taskId}`);
    }
    this.items.set(item.id, item);
    return item;
  }

  async attachTask(planItemId: string, taskId: string): Promise<SpecificationPlanItem> {
    const item = this.items.get(planItemId);
    if (!item) {
      throw new ValidationError(`plan item not found: ${planItemId}`);
    }
    const updated: SpecificationPlanItem = {
      ...item,
      taskId,
      updatedAt: new Date().toISOString(),
    };
    this.items.set(planItemId, updated);
    return updated;
  }

  async deletePlanItemsForSpecification(specificationId: string): Promise<void> {
    for (const item of await this.listPlanItems(specificationId)) {
      this.items.delete(item.id);
    }
  }
}
