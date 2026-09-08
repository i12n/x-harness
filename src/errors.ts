/** Exception hierarchy shared across the harness. */

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends HarnessError {}

export class DuplicateRepositoryError extends HarnessError {
  constructor(id: string) {
    super(`repository already exists: ${id}`);
  }
}

export class RepositoryNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`repository not found: ${id}`);
  }
}
