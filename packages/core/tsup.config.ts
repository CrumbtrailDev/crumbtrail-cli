import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/early.ts` is a second entry, not part of the main bundle: it must be
  // importable on its own line before anything else in the host app.
  //
  // `src/react` and `src/tauri` are framework adapters, published as the
  // `crumbtrail-core/react` and `crumbtrail-core/tauri` subpaths. They are
  // separate entries so that importing the core SDK never pulls React or the
  // Tauri IPC bridge into a bundle that has no use for them.
  entry: [
    'src/index.ts',
    'src/early.ts',
    'src/react/index.ts',
    'src/tauri/index.ts',
  ],
  format: ['esm', 'cjs'],
  // Optional peers: never bundled, so a consumer that imports only the core
  // entry never has to have them installed.
  external: ['react', '@tauri-apps/api', '@tauri-apps/api/core'],
  dts: true,
  clean: true,
});
