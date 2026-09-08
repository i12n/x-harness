import type { EventRecord, RecordEventInput } from "../domain/event.js";
import type { EventListFilter, EventStore } from "./eventStore.js";

/** Non-persistent event store, used by tests and memory-mode demos. */
export class InMemoryEventStore implements EventStore {
  private readonly events: EventRecord[] = [];
  private nextId = 1;

  async record(input: RecordEventInput): Promise<EventRecord> {
    const event: EventRecord = {
      id: String(this.nextId),
      type: input.type,
      taskId: input.taskId,
      runId: input.runId,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    };
    this.nextId += 1;
    this.events.push(event);
    return event;
  }

  async listEvents(filter: EventListFilter = {}): Promise<EventRecord[]> {
    let result = this.events.filter(
      (event) =>
        (filter.taskId === undefined || event.taskId === filter.taskId) &&
        (filter.runId === undefined || event.runId === filter.runId) &&
        (filter.type === undefined || event.type === filter.type),
    );
    if (filter.limit !== undefined && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }
    return result;
  }
}
