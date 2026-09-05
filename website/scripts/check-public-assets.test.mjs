import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkPublicAssets } from './check-public-assets.mjs';

async function fixture(t, built = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'munich3d-public-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const address = path.join(root, 'addresses/muenchner-rathaus');
  const files = ['model/muenchner-rathaus-100m.glb', 'model/muenchner-rathaus-100m.metadata.json', 'model/muenchner-rathaus-100m.source-mesh.json', 'area/rathaus-surfaces.json'];
  if (!built) files.push('catalog/muenchner-rathaus-100m.json');
  for (const file of files) {
    await mkdir(path.dirname(path.join(address, file)), { recursive: true });
    await writeFile(path.join(address, file), JSON.stringify({ id: 'muenchner-rathaus-100m' }));
  }
  return { root, address };
}

test('accepts only the complete public source and built bundles', async t => {
  await checkPublicAssets((await fixture(t)).root);
  await checkPublicAssets((await fixture(t, true)).root, true);
});
test('rejects an additional address even if Git would ignore it', async t => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, 'addresses/private-example'));
  await assert.rejects(checkPublicAssets(root), /only the Rathaus/);
});
test('rejects extra files and links inside the public folder', async t => {
  const { root, address } = await fixture(t);
  const extra = path.join(address, 'area/private-notes.json');
  await writeFile(extra, '{}');
  await assert.rejects(checkPublicAssets(root), /Unexpected/);
  await rm(extra);
  await symlink(path.join(address, 'model'), path.join(address, 'linked'));
  await assert.rejects(checkPublicAssets(root), /Unexpected/);
});
test('rejects missing bundle members and an incorrect catalog ID', async t => {
  const { root, address } = await fixture(t);
  await writeFile(path.join(address, 'catalog/muenchner-rathaus-100m.json'), '{"id":"other"}');
  await assert.rejects(checkPublicAssets(root), /catalog model ID/);
  await rm(path.join(address, 'model/muenchner-rathaus-100m.glb'));
  await assert.rejects(checkPublicAssets(root), /incomplete/);
});
