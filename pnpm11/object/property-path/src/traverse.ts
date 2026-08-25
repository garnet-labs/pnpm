/**
 * Read the own property {@link key} of {@link node} when a property path may
 * descend through it.
 *
 * A path descends only through a non-null object that owns {@link key}, and an
 * array is addressable by numbers alone, so `foo["0"]` never reaches the first
 * element of an array `foo`. Everything else resolves to `undefined`, which
 * ends the descent.
 */
export function descendIntoOwnProperty (node: unknown, key: string | number): unknown {
  if (
    typeof node !== 'object' ||
    node === null ||
    !Object.hasOwn(node, key) ||
    (Array.isArray(node) && typeof key !== 'number')
  ) return undefined

  return (node as Record<string | number, unknown>)[key]
}
