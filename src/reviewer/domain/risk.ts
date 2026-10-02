export type ChangeRiskLevel = "low" | "high";

export interface ChangeRisk {
  level: ChangeRiskLevel;
  reasons: string[];
}

/**
 * TASK-1222: some changes must not be waved through by the reviewer agent,
 * however convincing its verdict is — migrations, deployment, configuration,
 * secrets and CI affect production rather than this change.
 *
 * Deterministic on purpose: file paths are evidence, model prose is not.
 */
const HIGH_RISK_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)migrations?\//i, reason: "改动数据库迁移" },
  { pattern: /(^|\/)deploy\//i, reason: "改动部署脚本" },
  { pattern: /(^|\/)docker\//i, reason: "改动容器定义" },
  { pattern: /(^|\/)\.github\/workflows\//i, reason: "改动 CI 流程" },
  { pattern: /(^|\/)\.env(\.|$)/i, reason: "改动环境文件" },
  { pattern: /(^|\/)config\//i, reason: "改动配置" },
  { pattern: /secret/i, reason: "触碰密钥相关文件" },
  { pattern: /(^|\/)docker-compose\.ya?ml$/i, reason: "改动编排文件" },
];

const DEFAULT_MAX_FILES = 25;

export function assessChangeRisk(
  files: string[],
  options: { maxFiles?: number } = {},
): ChangeRisk {
  const reasons: string[] = [];
  for (const file of files) {
    const match = HIGH_RISK_PATTERNS.find((entry) => entry.pattern.test(file));
    if (match) {
      reasons.push(`${match.reason}：${file}`);
    }
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (files.length > maxFiles) {
    reasons.push(`改动范围过大：${files.length} 个文件（阈值 ${maxFiles}）`);
  }
  return {
    level: reasons.length > 0 ? "high" : "low",
    reasons: [...new Set(reasons)],
  };
}
