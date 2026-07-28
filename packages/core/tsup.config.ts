import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/early.ts` is a second entry, not part of the main bundle: it must be
  // importable on its own line before anything else in the host app.
  entry: ['src/index.ts', 'src/early.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});
