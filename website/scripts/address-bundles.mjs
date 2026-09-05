import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const websiteDirectory = fileURLToPath(new URL('../', import.meta.url));
export const addressDirectory = path.join(websiteDirectory, 'addresses');
const suffixes = ['.glb', '.metadata.json', '.source-mesh.json'];
const safeName = /^[a-z0-9][a-z0-9-]*$/;
export async function listIfPresent(directory) {
  return readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}
/** Each address owns its source bundles, surface snapshots and generated catalogs. */
export async function discoverAddressBundles(root = addressDirectory) {
  const bundles = [];
  const seen = new Set();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!safeName.test(entry.name)) throw Error(`Invalid address folder: ${entry.name}`);
    const directory = path.join(root, entry.name);
    const modelDirectory = path.join(directory, 'model');
    const files = await listIfPresent(modelDirectory);
    const stems = new Set(files.flatMap(file => {
      const suffix = suffixes.find(suffix => file.endsWith(suffix));
      return suffix ? [file.slice(0, -suffix.length)] : [];
    }));
    for (const id of [...stems].sort()) {
      if (!safeName.test(id)) throw Error(`Invalid model stem: ${id}`);
      if (seen.has(id)) throw Error(`Duplicate model ID: ${id}`);
      const missing = suffixes.filter(suffix => !files.includes(id + suffix));
      if (missing.length) throw Error(`Incomplete model bundle "${id}"; missing ${missing.join(', ')}`);
      seen.add(id);
      bundles.push({ id, address: entry.name, directory, modelDirectory,
        catalogPath: path.join(directory, 'catalog', `${id}.json`),
        assetBase: `/addresses/${entry.name}` });
    }
  }
  return bundles;
}
export async function findAddressBundle(id) {
  if (!safeName.test(id)) throw Error('Invalid model stem');
  const bundle = (await discoverAddressBundles()).find(bundle => bundle.id === id);
  if (!bundle) throw Error(`No permanent model bundle: ${id}`);
  return bundle;
}
export async function readAddressCatalog(id) {
  const bundle = await findAddressBundle(id);
  return JSON.parse(await readFile(bundle.catalogPath, 'utf8'));
}
