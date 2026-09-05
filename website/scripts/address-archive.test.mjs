import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { exportArchive, importArchive } from '../lib/address-archive.mjs';
const modelId = 'muenchner-rathaus-100m';
const root = new URL('../addresses/muenchner-rathaus/', import.meta.url);
const files = {};
for (const [name, path] of Object.entries({ 'model.glb': `model/${modelId}.glb`, 'metadata.json': `model/${modelId}.metadata.json`, 'source-mesh.json': `model/${modelId}.source-mesh.json`, 'area.json': 'area/rathaus-surfaces.json' })) files[name] = new Uint8Array(await readFile(new URL(path, root)));
const area = JSON.parse(new TextDecoder().decode(files['area.json']));
area.primaryFacade = { gmlId: 'reference-profile', notes: ['Photo-backed details'], windows: [{ width: 1.25 }] };
area.neighborFacades = [{ gmlId: 'neighbor-reference', balconies: [{ depth: 1.4 }] }];
files['area.json'] = strToU8(JSON.stringify(area));
const archive = await exportArchive({ modelId, files });
test('roundtrip retains every original byte, including full facade profiles', async () => {
  const result = await importArchive(archive);
  assert.equal(result.catalog.runtime, true);
  assert.match(result.id, /^import-/);
  assert.equal(result.catalog.architectureStyle, 'gothic');
  for (const name of Object.keys(files)) assert.deepEqual(result.files[name], files[name]);
  assert.equal(result.catalog.buildingCount, JSON.parse(new TextDecoder().decode(files['metadata.json'])).buildings.length);
  const reExport = await exportArchive({ modelId, files: Object.fromEntries(Object.entries(result.files).filter(([name]) => name !== 'manifest.json')) });
  assert.equal((await importArchive(reExport)).id, result.id);
});
test('source-only archives need no facade data', async () => {
  const { 'area.json': _, ...sourceOnly } = files;
  const result = await importArchive(await exportArchive({ modelId, files: sourceOnly }));
  assert.equal(result.catalog.architectureStyle, undefined);
});
test('reject missing, corrupt, unknown-version and unexpected files', async () => {
  const unpacked = unzipSync(archive);
  const { 'model.glb': _, ...missing } = unpacked;
  await assert.rejects(importArchive(zipSync(missing)), /missing required/);
  await assert.rejects(importArchive(zipSync({ ...unpacked, 'metadata.json': strToU8('{}') })), /Damaged/);
  await assert.rejects(importArchive(zipSync({ ...unpacked, '../private.txt': strToU8('bad') })), /unexpected/);
  const manifest = JSON.parse(new TextDecoder().decode(unpacked['manifest.json']));
  await assert.rejects(importArchive(zipSync({ ...unpacked, 'manifest.json': strToU8(JSON.stringify({ ...manifest, version: 99 })) })), /Unsupported/);
});
test('reject self-contained bundle with inconsistent source and metadata', async () => {
  const metadata = JSON.parse(new TextDecoder().decode(files['metadata.json']));
  metadata.buildings.pop();
  const invalid = await exportArchive({ modelId, files: { ...files, 'metadata.json': strToU8(JSON.stringify(metadata)) } });
  await assert.rejects(importArchive(invalid));
});
