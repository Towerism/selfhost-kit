// `node --import ./test/helpers/ts-resolve.mjs …` lets a child process run the TypeScript source:
// Node strips the types itself, and this hook maps the `./x.js` specifiers the source uses to `./x.ts`.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      const code = /** @type {{ code?: unknown } | undefined} */ (err)?.code;
      if (code !== 'ERR_MODULE_NOT_FOUND' || !relative || !specifier.endsWith('.js')) throw err;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
