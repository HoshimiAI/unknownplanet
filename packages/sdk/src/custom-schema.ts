import type { JsonValue, PlanetJsonSchema } from "@unknown-planet/core";
import { PlanetValidationError } from "./errors.js";

const typeOf = (value: JsonValue): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const equal = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]!));
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightObject = right as Record<string, JsonValue>;
  return leftKeys.length === Object.keys(rightObject).length && leftKeys.every((key) => Object.hasOwn(rightObject, key) && equal(left[key]!, rightObject[key]!));
};

export function validateCustomData(schema: PlanetJsonSchema | undefined, value: JsonValue | undefined, label: string): void {
  if (schema === undefined) return;
  const issues: string[] = [];
  const visit = (rule: PlanetJsonSchema, current: JsonValue, path: string): void => {
    if (typeof current === "number" && !Number.isFinite(current)) { issues.push(`${path} must be a finite JSON number`); return; }
    if (typeof rule === "boolean") { if (!rule) issues.push(`${path} is not allowed`); return; }
    if (rule.const !== undefined && !equal(rule.const, current)) issues.push(`${path} must equal its configured constant`);
    if (rule.enum && !rule.enum.some((candidate) => equal(candidate, current))) issues.push(`${path} must match one of its configured values`);
    if (rule.type) {
      const allowed = Array.isArray(rule.type) ? rule.type : [rule.type];
      const actual = typeOf(current);
      if (!allowed.some((item) => item === actual || (item === "number" && actual === "number") || (item === "integer" && typeof current === "number" && Number.isInteger(current)))) {
        issues.push(`${path} must be ${allowed.join(" or ")}`); return;
      }
    }
    if (typeof current === "string") {
      if (rule.minLength !== undefined && current.length < rule.minLength) issues.push(`${path} is shorter than minLength`);
      if (rule.maxLength !== undefined && current.length > rule.maxLength) issues.push(`${path} is longer than maxLength`);
      if (rule.pattern !== undefined) {
        try { if (!new RegExp(rule.pattern).test(current)) issues.push(`${path} does not match pattern`); }
        catch { throw new PlanetValidationError(`Invalid custom schema pattern at '${path}'.`); }
      }
    }
    if (typeof current === "number") {
      if (rule.minimum !== undefined && current < rule.minimum) issues.push(`${path} is below minimum`);
      if (rule.maximum !== undefined && current > rule.maximum) issues.push(`${path} is above maximum`);
    }
    if (Array.isArray(current) && rule.items !== undefined) current.forEach((item, index) => visit(rule.items!, item, `${path}[${index}]`));
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      const object = current as Record<string, JsonValue>;
      for (const required of rule.required ?? []) if (!Object.hasOwn(object, required)) issues.push(`${path}.${required} is required`);
      for (const [key, child] of Object.entries(object)) {
        const childSchema = rule.properties?.[key];
        if (childSchema !== undefined) visit(childSchema, child, `${path}.${key}`);
        else if (rule.additionalProperties === false) issues.push(`${path}.${key} is not allowed`);
        else if (rule.additionalProperties && typeof rule.additionalProperties === "object") visit(rule.additionalProperties, child, `${path}.${key}`);
      }
    }
  };
  visit(schema, value === undefined ? {} : value, label);
  if (issues.length) throw new PlanetValidationError(`Custom data for '${label}' is invalid: ${issues.slice(0, 5).join("; ")}.`);
}
