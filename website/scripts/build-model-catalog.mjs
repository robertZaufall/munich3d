import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalogEntry } from './catalog-entry.mjs';

const websiteDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const modelDirectory = path.join(websiteDirectory, 'public', 'model');
const catalogDirectory = path.join(websiteDirectory, 'lib', 'model-catalog');
const bundleSuffixes = ['.glb', '.metadata.json', '.source-mesh.json'];

const files = await readdir(modelDirectory);
const stems = new Set();

for (const file of files) {
  const suffix = bundleSuffixes.find((candidate) => file.endsWith(candidate));
  if (suffix) stems.add(file.slice(0, -suffix.length));
}

if (stems.size === 0) {
  throw new Error(`No model bundles found in ${modelDirectory}`);
}

const models = [];

for (const stem of [...stems].sort((left, right) => left.localeCompare(right))) {
  const missing = bundleSuffixes.filter(
    (suffix) => !files.includes(`${stem}${suffix}`),
  );
  if (missing.length > 0) {
    throw new Error(
      `Incomplete model bundle "${stem}"; missing ${missing.join(', ')}`,
    );
  }

  const metadata = JSON.parse(
    await readFile(path.join(modelDirectory, `${stem}.metadata.json`), 'utf8'),
  );
  models.push(createCatalogEntry({
    id: stem,
    modelPath: `/model/${stem}.glb`,
    sourceMeshPath: `/model/${stem}.source-mesh.json`,
    metadataPath: `/model/${stem}.metadata.json`,
    metadata,
  }));
}

models.sort((left, right) =>
  left.address.localeCompare(right.address, 'de', { sensitivity: 'base' }),
);

await mkdir(catalogDirectory, { recursive: true });

const catalogFiles = await readdir(catalogDirectory);
const expectedCatalogFiles = new Set(models.map((model) => `${model.id}.json`));
for (const file of catalogFiles) {
  if (file.endsWith('.json') && !expectedCatalogFiles.has(file)) {
    await unlink(path.join(catalogDirectory, file));
  }
}

for (const model of models) {
  await writeFile(
    path.join(catalogDirectory, `${model.id}.json`),
    `${JSON.stringify(model, null, 2)}\n`,
  );
}

console.log(
  `Model catalog: ${models.length} bundles -> ${catalogDirectory}/*.json`,
);
