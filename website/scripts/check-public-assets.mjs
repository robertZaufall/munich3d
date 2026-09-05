import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const website = fileURLToPath(new URL('../', import.meta.url));
const allowedAddress = 'muenchner-rathaus';
const allowedModel = 'muenchner-rathaus-100m';
const expected = new Set([
  `model/${allowedModel}.glb`,
  `model/${allowedModel}.metadata.json`,
  `model/${allowedModel}.source-mesh.json`,
  `area/rathaus-surfaces.json`,
  `catalog/${allowedModel}.json`,
]);

export async function checkPublicAssets(root, built = false) {
  const addresses = path.join(root, 'addresses');
  const entries = await readdir(addresses, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== allowedAddress || !entries[0].isDirectory()) {
    throw new Error('Public deployment must contain only the Rathaus address folder. Use a clean Git checkout.');
  }
  const found = new Set();
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), `${relative}/`);
      else if (entry.isFile() && expected.has(relative) && !(built && relative.startsWith('catalog/'))) found.add(relative);
      else throw new Error(`Unexpected public address asset: ${relative}`);
    }
  }
  await visit(path.join(addresses, allowedAddress));
  const required = [...expected].filter(name => !built || !name.startsWith('catalog/'));
  if (required.some(name => !found.has(name))) throw new Error('Public Rathaus bundle is incomplete.');
  if (!built) {
    const catalog = JSON.parse(await readFile(path.join(addresses, allowedAddress, `catalog/${allowedModel}.json`), 'utf8'));
    if (catalog.id !== allowedModel) throw new Error('Unexpected public catalog model ID.');
  }
  console.log(`Public asset check passed: ${found.size} Rathaus files; no other addresses.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = process.argv.includes('--built');
  await checkPublicAssets(built ? path.join(website, 'dist/cloudflare/munich3d') : website, built);
}
