#!/usr/bin/env node
/**
 * TASK-1244: 用**真模型**跑意图语料，输出命中率与未命中清单。
 *
 *   npm run build            # 脚本读 dist 里的提示词，跟线上一致
 *   AI_LLM_API_KEY=… node scripts/eval-intent.mjs
 *
 * 判定标准（方案 §10）：命中率 ≥ 90%，且 $dangerous 里的两条危险误判 = 0。
 * 需要 AI_LLM_BASE_URL / AI_LLM_MODEL / AI_LLM_API_KEY（与部署同源）。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { intentSystemPrompt } from "../dist/command/llmIntentEngine.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  await readFile(join(here, "..", "tests", "fixtures", "intentPhrasings.json"), "utf8"),
);

const baseUrl = process.env.AI_LLM_BASE_URL;
const apiKey = process.env.AI_LLM_API_KEY;
const model = process.env.AI_LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
  console.error("需要 AI_LLM_BASE_URL / AI_LLM_MODEL / AI_LLM_API_KEY");
  process.exit(2);
}

const stageLabel = {
  clarifying: "澄清中（还没确认要做什么）",
  developing: "开发中（任务还没全做完）",
  awaiting_acceptance: "待验收（做完了，还没推测试环境）",
  awaiting_release: "待发布（测试环境已就绪，等你确认）",
  released: "已上线",
};
const context = `当前需求：面包屑分隔符间距\n阶段：${stageLabel[fixture.stage] ?? fixture.stage}`;
const system = intentSystemPrompt({ repositories: [] });

const classify = async (text) => {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${context}\n\n用户说：${text}` },
      ],
    }),
  });
  const body = await response.json();
  try {
    return JSON.parse(body?.choices?.[0]?.message?.content ?? "").action ?? "?";
  } catch {
    return "?";
  }
};

const isQuestion = (text) => /[？?]\s*$|吗\s*$|是不是|能不能/.test(text);
const isBare = (text) => /^(可以|行|好|嗯|ok|批准)[。.!！]?$/i.test(text.trim());

let hits = 0;
let dangerous = 0;
const misses = [];
for (const entry of fixture.cases) {
  const got = await classify(entry.text);
  const acceptable = [entry.expect, ...(entry.allowAlso ?? [])];
  const ok = acceptable.includes(got);
  const irreversible = ["deploy", "publish", "reject"].includes(got);
  const risky = (isQuestion(entry.text) || isBare(entry.text)) && irreversible && got !== "publish";
  if (ok) hits += 1;
  if (risky) dangerous += 1;
  if (!ok || risky) {
    misses.push(`${ok ? "⚠️" : "✗"} ${entry.text} → ${got}（期望 ${acceptable.join("/")}）`);
  }
}

const rate = Math.round((hits / fixture.cases.length) * 100);
console.log(`命中 ${hits}/${fixture.cases.length} = ${rate}%，危险误判 ${dangerous}`);
for (const line of misses) {
  console.log(line);
}
if (dangerous > 0 || rate < 90) {
  console.error("\n未达标：危险误判必须为 0，命中率必须 ≥ 90%");
  process.exit(1);
}
