/**
 * Custom application error classes.
 * Each class has a `toResponse()` method — Elysia calls it automatically
 * when the error is thrown inside a handler, returning a structured JSON response.
 */

export class ValidationError extends Error {
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }

  toResponse() {
    return Response.json({ error: this.message }, { status: 422 });
  }
}
