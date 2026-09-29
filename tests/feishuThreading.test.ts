import { describe, expect, it } from "vitest";
import { parseFeishuEvent } from "../src/channel/feishu/events.js";

function envelope(message: Record<string, unknown>): Record<string, unknown> {
  return {
    header: { event_type: "im.message.receive_v1", event_id: "evt-1" },
    event: {
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        message_type: "text",
        create_time: "1758240000000",
        content: JSON.stringify({ text: "hi" }),
        ...message,
      },
    },
  };
}

describe("Feishu threading", () => {
  it("keeps a quoted reply in the same conversation", () => {
    // Quote replies carry parent_id (and often root_id); they are not threads.
    const parsed = parseFeishuEvent(
      envelope({ parent_id: "om_parent", root_id: "om_root" }),
    );
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      return;
    }
    expect(parsed.message.metadata?.threadId).toBeUndefined();
  });

  it("still splits real topic threads", () => {
    const parsed = parseFeishuEvent(envelope({ thread_id: "omt_topic_1" }));
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      return;
    }
    expect(parsed.message.metadata?.threadId).toBe("omt_topic_1");
  });
});
