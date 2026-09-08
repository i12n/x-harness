import { randomUUID } from "node:crypto";

/** Generate an id such as `repo-3f2a1b4c9d`. */
export function makeId(prefix: string): string {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  return `${prefix}-${suffix}`;
}

/** Turn a display name into a filesystem-friendly slug. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "repo";
}
