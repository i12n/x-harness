/**
 * Secrets are resolved at Run time and injected per Run only.
 * Values must never be written to Repository/Task/Run/Event or logs.
 */
export interface SecretStore {
  resolve(names: string[]): Promise<Record<string, string>>;
}

/** Reads `AI_SECRET_<NAME>` (falling back to `<NAME>`) from the environment. */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly prefix = "AI_SECRET_") {}

  async resolve(names: string[]): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const name of names) {
      const value = process.env[`${this.prefix}${name}`] ?? process.env[name];
      if (value !== undefined && value !== "") {
        resolved[name] = value;
      }
    }
    return resolved;
  }
}
