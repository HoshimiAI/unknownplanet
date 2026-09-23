import { PlanetValidationError } from "./errors.js";

/** A typed key for an application-defined provider extension. */
export interface PlanetExtension<T> { readonly key: string; readonly __type?: T }

export function definePlanetExtension<T>(key: string): PlanetExtension<T> {
  if (!key.trim()) throw new PlanetValidationError("Planet extension keys cannot be empty.");
  return Object.freeze({ key });
}
