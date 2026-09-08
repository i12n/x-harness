#!/usr/bin/env node

import { Command } from "commander";
import type { Repository } from "../domain/repository.js";
import { openRepositoryStore } from "../store/index.js";
import {
  createRepositoryCommand,
  listRepositoriesCommand,
  showRepositoryCommand,
} from "./commands/repositoryCommands.js";
import type { RepositoryCreateOptions } from "./commands/repositoryCommands.js";

const program = new Command();
program
  .name("ai")
  .description("AI Coding Harness v0.1")
  .version("0.1.0");

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

async function withStore(
  run: (handle: Awaited<ReturnType<typeof openRepositoryStore>>) => Promise<void>,
): Promise<void> {
  const handle = await openRepositoryStore();
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

const repository = program.command("repository").description("register and inspect repositories");

repository
  .command("create")
  .description("register a new repository")
  .option("--id <id>", "repository id (default: generated)")
  .requiredOption("--name <name>", "repository name")
  .requiredOption("--url <url>", "clone url (http/https/ssh/git)")
  .option("--default-branch <branch>", "default branch (default: main)")
  .option("--local-path <path>", "local checkout path (default: ~/ai-repos/<name>)")
  .option("--verify <command>", "verification command (repeatable)", collect, [])
  .action(async (options: RepositoryCreateOptions) => {
    await withStore(async ({ store }) => {
      const repo = await createRepositoryCommand(store, options);
      console.log(`Created ${repo.id} (${repo.name})`);
      printRepository(repo);
    });
  });

repository
  .command("list")
  .description("list registered repositories")
  .action(async () => {
    await withStore(async ({ store }) => {
      const repos = await listRepositoriesCommand(store);
      if (repos.length === 0) {
        console.log("No repositories registered.");
        return;
      }
      console.log("ID\tNAME\tURL\tBRANCH\tCHECKS");
      for (const repo of repos) {
        console.log(
          `${repo.id}\t${repo.name}\t${repo.url}\t${repo.defaultBranch}\t${repo.verificationCommands.length}`,
        );
      }
    });
  });

repository
  .command("show <id>")
  .description("show one repository")
  .action(async (id: string) => {
    await withStore(async ({ store }) => {
      const repo = await showRepositoryCommand(store, id);
      printRepository(repo);
    });
  });

function printRepository(repo: Repository): void {
  console.log(`id: ${repo.id}`);
  console.log(`name: ${repo.name}`);
  console.log(`url: ${repo.url}`);
  console.log(`default_branch: ${repo.defaultBranch}`);
  console.log(`local_path: ${repo.localPath}`);
  console.log("verification:");
  if (repo.verificationCommands.length === 0) {
    console.log("  (none)");
  } else {
    for (const command of repo.verificationCommands) {
      console.log(`  - ${command}`);
    }
  }
}

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `error: ${error.message}`;
  }
  return `error: ${String(error)}`;
}
