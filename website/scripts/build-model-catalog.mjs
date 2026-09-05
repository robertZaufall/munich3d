import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCatalogEntry } from './catalog-entry.mjs';
import { addressDirectory, discoverAddressBundles, listIfPresent } from './address-bundles.mjs';

const bundles = await discoverAddressBundles();
if (!bundles.length) throw Error(`No model bundles found in ${addressDirectory}`);
const addresses = new Map();
for (const bundle of bundles) {
  if (!addresses.has(bundle.directory)) addresses.set(bundle.directory, []);
  addresses.get(bundle.directory).push(bundle);
}
for (const [directory, localBundles] of addresses) {
  const areas = new Map();
  for (const file of await listIfPresent(path.join(directory, 'area'))) {
    if (!file.endsWith('.json')) continue;
    const area = JSON.parse(await readFile(path.join(directory, 'area', file), 'utf8'));
    if (!area.modelId) continue;
    if (!localBundles.some(bundle => bundle.id === area.modelId)) throw Error(`Surface ${file} has no bundle in its address folder`);
    if (areas.has(area.modelId)) throw Error(`Duplicate area for ${area.modelId}`);
    areas.set(area.modelId, { areaSurfacePath: `${localBundles[0].assetBase}/area/${file}`, architectureStyle: area.architectureStyle });
  }
  const catalogDirectory = path.join(directory, 'catalog');
  await mkdir(catalogDirectory, { recursive: true });
  for (const file of await listIfPresent(catalogDirectory)) {
    if (file.endsWith('.json') && !localBundles.some(bundle => file === `${bundle.id}.json`)) await unlink(path.join(catalogDirectory, file));
  }
  for (const bundle of localBundles) {
    const base = `${bundle.assetBase}/model/${bundle.id}`;
    const metadata = JSON.parse(await readFile(path.join(bundle.modelDirectory, `${bundle.id}.metadata.json`), 'utf8'));
    const catalog = { ...createCatalogEntry({ id: bundle.id, modelPath: `${base}.glb`, sourceMeshPath: `${base}.source-mesh.json`, metadataPath: `${base}.metadata.json`, metadata }), ...areas.get(bundle.id) };
    await writeFile(bundle.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  }
}
console.log(`Model catalog: ${bundles.length} bundles in ${addresses.size} address folders`);
