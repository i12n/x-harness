import type { EventRecord, RecordEventInput } from "../domain/event.js";

export interface EventListFilter {
  taskId?: string;
  runId?: string;
  problemId?: string;
  type?: string;
  limit?: number;
}

/** Persistence contract for the event history. */
export interface EventStore {
  record(input: RecordEventInput): Promise<EventRecord>;
  listEvents(filter?: EventListFilter): Promise<EventRecord[]>;
}
