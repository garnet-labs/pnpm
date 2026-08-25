import { parsePropertyPath } from './parse.js'
import { descendIntoOwnProperty } from './traverse.js'

/**
 * Get the value of a property path in a nested object.
 *
 * This function returns `undefined` if it meets non-object at some point.
 */
export function getObjectValueByPropertyPath (object: unknown, propertyPath: Iterable<string | number>): unknown {
  let value: unknown = object

  for (const name of propertyPath) {
    value = descendIntoOwnProperty(value, name)
  }

  return value
}

/**
 * Get the value of a property path in a nested object.
 *
 * This function returns `undefined` if it meets non-object at some point.
 */
export const getObjectValueByPropertyPathString =
  (object: unknown, propertyPath: string): unknown => getObjectValueByPropertyPath(object, parsePropertyPath(propertyPath))
