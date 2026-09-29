/**
 * Model-output helpers shared by the control plane. Re-exported from the agent
 * layer so `src/command/**` can parse model JSON without importing `../agent/`
 * (the command layer boundary forbids that).
 */
export { extractAgentText, parseJsonObject } from "../agent/output.js";
