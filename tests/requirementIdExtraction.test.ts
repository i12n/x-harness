import { describe, expect, it } from "vitest";
import { extractRequirementId } from "../src/server/intentTriage.js";

// TASK-1259: the requirement id is extracted deterministically, before the
// model runs, so a named requirement is never guessed at.
describe("prob-… extraction", () => {
  it("finds the id anywhere in the message", () => {
    expect(extractRequirementId("prob-950662cc5b 现在到哪一步了")).toBe("prob-950662cc5b");
    expect(extractRequirementId("发布 prob-950662cc5b")).toBe("prob-950662cc5b");
    expect(extractRequirementId("这条（prob-950662cc5b）先打回")).toBe("prob-950662cc5b");
  });

  it("normalizes case and ignores the machine ids", () => {
    expect(extractRequirementId("PROB-950662CC5B 发布")).toBe("prob-950662cc5b");
    expect(extractRequirementId("task-spec-9d0df14cad-0 修好了吗")).toBeUndefined();
    expect(extractRequirementId("dlv-9128847051 发布")).toBeUndefined();
  });

  it("does not mistake prose for an id", () => {
    expect(extractRequirementId("problem 是什么")).toBeUndefined();
    expect(extractRequirementId("prob-")).toBeUndefined();
  });
});
