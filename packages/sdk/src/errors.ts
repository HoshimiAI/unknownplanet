export class PlanetError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class PlanetValidationError extends PlanetError { constructor(message: string) { super(message, "invalid_request", 400); } }
export class PlanetNotFoundError extends PlanetError { constructor(message: string) { super(message, "not_found", 404); } }
export class PlanetConflictError extends PlanetError { constructor(message: string) { super(message, "conflict", 409); } }
export class PlanetCapabilityError extends PlanetError { constructor(capability: string) { super(`Planet was created without a ${capability} provider.`, "capability_unavailable", 503); } }
export class PlanetProviderError extends PlanetError {
  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : "Unknown provider failure";
    super(`Provider failed during ${operation}: ${detail}`, "provider_error", 502, { cause });
  }
}
