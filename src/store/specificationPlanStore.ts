import type {
  CreateSpecificationPlanItemInput,
  SpecificationPlanItem,
} from "../domain/specificationPlan.js";

/**
 * Persistence contract for `specification_plans` (Phase 12 / TASK-1202):
 * one row per plan item, linked 1:1 to the Task it produced.
 */
export interface SpecificationPlanStore {
  listPlanItems(specificationId: string): Promise<SpecificationPlanItem[]>;
  createPlanItem(
    input: CreateSpecificationPlanItemInput,
  ): Promise<SpecificationPlanItem>;
  /** Backfills `task_id` after the Task exists. */
  attachTask(planItemId: string, taskId: string): Promise<SpecificationPlanItem>;
  deletePlanItemsForSpecification(specificationId: string): Promise<void>;
}
