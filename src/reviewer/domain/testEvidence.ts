export interface TestEvidence {
  /** Production code touched by the change. */
  sourceFiles: string[];
  /** Files that are recognisably tests. */
  testFiles: string[];
  /** Production code changed while not a single test was touched. */
  missingTestChange: boolean;
}

const TEST_FILE_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|__tests__|spec|e2e)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+$/i,
];

/** Docs and lockfiles are not "code" for the purpose of this check. */
const NON_CODE_PATTERNS: RegExp[] = [
  /\.mdx?$/i,
  /\.txt$/i,
  /(^|\/)docs?\//i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
];

/**
 * TASK-1225: "the behaviour changed but no test changed" is the most common
 * shortcut, and a reviewer looking at green checks tends to miss it.
 *
 * Deterministic by file path, like the risk classifier: the harness states the
 * fact, the reviewer gets to explain it, and the escalation policy decides.
 */
export function assessTestEvidence(files: string[]): TestEvidence {
  const testFiles = files.filter((file) => TEST_FILE_PATTERNS.some((p) => p.test(file)));
  const sourceFiles = files.filter(
    (file) =>
      !TEST_FILE_PATTERNS.some((p) => p.test(file)) &&
      !NON_CODE_PATTERNS.some((p) => p.test(file)),
  );
  return {
    sourceFiles,
    testFiles,
    missingTestChange: sourceFiles.length > 0 && testFiles.length === 0,
  };
}

/** One line the reviewer (and the human) can act on. */
export function describeTestEvidence(evidence: TestEvidence): string | undefined {
  if (!evidence.missingTestChange) {
    return undefined;
  }
  const sample = evidence.sourceFiles.slice(0, 3).join(", ");
  return `改了 ${evidence.sourceFiles.length} 个生产文件但没有测试变更（如 ${sample}）`;
}
