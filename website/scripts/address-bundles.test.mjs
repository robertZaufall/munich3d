import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverAddressBundles } from './address-bundles.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'address-bundles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function bundle(root, address, id, suffixes = ['.glb', '.metadata.json', '.source-mesh.json']) {
  const dir = path.join(root, address, 'model');
  await mkdir(dir, { recursive: true });
  for (const suffix of suffixes) await writeFile(path.join(dir, id + suffix), '{}');
}
test('multiple radii belong to one address folder; a second address stays separate', async t => {
  const root = await fixture(t);
  await bundle(root, 'sample-house', 'sample-house-35m');
  await bundle(root, 'sample-house', 'sample-house-100m');
  await bundle(root, 'second-house', 'second-house-35m');
  const result = await discoverAddressBundles(root);
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map(b => b.directory)).size, 2);
  for (const b of result) {
    assert.ok(b.catalogPath.startsWith(b.directory + path.sep));
    assert.equal(b.assetBase, `/addresses/${b.address}`);
  }
});
test('a partially copied address fails rather than disappearing from the chooser', async t => {
  const root = await fixture(t);
  await bundle(root, 'sample', 'sample-35m', ['.metadata.json']);
  await assert.rejects(discoverAddressBundles(root), /Incomplete model bundle/);
});
test('a copied model ID cannot collide across address folders', async t => {
  const root = await fixture(t);
  await bundle(root, 'one', 'sample-35m');
  await bundle(root, 'two', 'sample-35m');
  await assert.rejects(discoverAddressBundles(root), /Duplicate model ID/);
});
