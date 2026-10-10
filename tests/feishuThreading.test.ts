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

  // TASK-1260: formatted messages arrive as `post`; dropping them made the bot
  // look dead for any requirement typed as a list.
  it("reads rich text (post) instead of dropping it", () => {
    const post = {
      zh_cn: {
        title: "x-music 添加下载歌曲功能",
        content: [
          [{ tag: "text", text: "歌曲列表（专辑、歌单）加下载按钮" }],
          [
            { tag: "text", text: "不支持整个专辑下载" },
            { tag: "a", text: "，详情见文档", href: "https://example.test" },
          ],
          [{ tag: "img", image_key: "img_v2_1" }],
          [{ tag: "at", user_name: "老王" }],
        ],
      },
    };
    const parsed = parseFeishuEvent(
      envelope({ message_type: "post", content: JSON.stringify(post) }),
    );
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      return;
    }
    expect(parsed.message.text).toContain("x-music 添加下载歌曲功能");
    expect(parsed.message.text).toContain("歌曲列表（专辑、歌单）加下载按钮");
    expect(parsed.message.text).toContain("不支持整个专辑下载");
    expect(parsed.message.text).toContain("[图片]");
    expect(parsed.message.text).toContain("@老王");
  });

  it("reads a flat (v1) post body too", () => {
    const parsed = parseFeishuEvent(
      envelope({
        message_type: "post",
        content: JSON.stringify({
          title: "纯文本标题",
          content: [[{ tag: "text", text: "正文" }]],
        }),
      }),
    );
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      return;
    }
    expect(parsed.message.text).toContain("纯文本标题");
    expect(parsed.message.text).toContain("正文");
  });
});
