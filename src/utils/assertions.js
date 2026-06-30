// @ts-check

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is string}
 */
export function assertString(name, value) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is string[]}
 */
export function assertStringArray(name, value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be an array of strings.`);
  }
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is Record<string, unknown>[]}
 */
export function assertObjectArray(name, value) {
  if (
    !Array.isArray(value) ||
    value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))
  ) {
    throw new TypeError(`${name} must be an array of objects.`);
  }
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {string[]} allowedValues
 * @returns {asserts value is string}
 */
export function assertKnownValue(name, value, allowedValues) {
  assertString(name, value);

  if (!allowedValues.includes(value)) {
    throw new Error(`Invalid ${name}: ${value}. Allowed values: ${allowedValues.join(", ")}.`);
  }
}
