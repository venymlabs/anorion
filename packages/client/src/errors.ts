export class AnorionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "AnorionError";
  }
}

export class AuthenticationError extends AnorionError {
  constructor(message = "Authentication failed", body?: unknown) {
    super(message, 401, body);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends AnorionError {
  public readonly retryAfter: number;

  constructor(retryAfter = 0, body?: unknown) {
    super(`Rate limited — retry after ${retryAfter}s`, 429, body);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class NotFoundError extends AnorionError {
  constructor(resource: string, id: string, body?: unknown) {
    super(`${resource} not found: ${id}`, 404, body);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AnorionError {
  public readonly violations: ReadonlyArray<{ field: string; message: string }>;

  constructor(
    violations: ReadonlyArray<{ field: string; message: string }>,
    body?: unknown,
  ) {
    super("Validation failed", 422, body);
    this.name = "ValidationError";
    this.violations = violations;
  }
}
