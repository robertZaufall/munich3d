import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverAddressBundles, listIfPresent } from './address-bundles.mjs';

/** Dev serves /addresses from the Vite root; builds copy the same static assets. */
export function addressAssets() {
  return {
    name: 'address-bundle-assets',
    async generateBundle() {
      const bundles = await discoverAddressBundles();
      const directories = new Map(bundles.map(bundle => [bundle.directory, bundle.assetBase]));
      for (const [directory, base] of directories) {
        for (const kind of ['model', 'area']) {
          for (const file of await listIfPresent(path.join(directory, kind))) {
            if (!file.endsWith('.json') && !file.endsWith('.glb')) continue;
            this.emitFile({ type: 'asset', fileName: `${base.slice(1)}/${kind}/${file}`, source: await readFile(path.join(directory, kind, file)) });
          }
        }
      }
    },
  };
}
