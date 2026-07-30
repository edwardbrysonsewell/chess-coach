/**
 * Module resolution hook so `node tools/<something>.ts` can run against the
 * TypeScript sources directly.
 *
 * Node 24 strips types from .ts files on its own, but it will not resolve an
 * import written as './position.js' to './position.ts' — and TypeScript's
 * NodeNext convention requires the .js form in source. This bridges the two.
 * Zero dependencies on purpose: nothing here ships to the phone.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      specifier.endsWith('.js')
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
}
