import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectLoader, Box3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadFacadeExporter } from './export-building-facades.mjs';
import { findAddressBundle, readAddressCatalog } from './address-bundles.mjs';
import { validateSceneGlb } from '../lib/blender-export.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const id = process.argv[2] || 'muenchner-rathaus-100m';
const bundle = await findAddressBundle(id);
const catalog = await readAddressCatalog(id);
const source = new Uint8Array(await fs.readFile(path.join(bundle.modelDirectory, `${id}.glb`)));
const area = new Uint8Array(await fs.readFile(path.join(root, catalog.areaSurfacePath)));
const build = await loadFacadeExporter();
const glb = await build(source.buffer, area, { complete: true });
validateSceneGlb(Buffer.from(glb));
const json = await build(source.buffer, area, { complete: true, format: 'three' });
const gltfScene = (await new GLTFLoader().parseAsync(glb.buffer, '')).scene;
const threeScene = new ObjectLoader().parse(JSON.parse(new TextDecoder().decode(json)));
const sourceScene = (await new GLTFLoader().parseAsync(source.buffer, '')).scene;
function metrics(scene) {
  const features = []; let triangles = 0; let surroundings = false; let balconies = 0;
  scene.traverse(object => {
    if (object.userData.role) features.push(object.userData.gml_id);
    if (object.name.replaceAll('_', ' ') === 'Reconstructed mapped surfaces') surroundings = true;
    if (Number.isFinite(object.userData.deckHeight)) balconies++;
    if (object.isMesh) triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
  });
  return { features: features.sort(), triangles, surroundings, balconies };
}
const expected = metrics(sourceScene);
const exported = metrics(gltfScene);
assert.deepEqual(exported.features, expected.features, 'Every original source feature must survive');
assert.ok(exported.surroundings, 'Missing mapped surroundings');
assert.ok(exported.triangles > expected.triangles, 'Missing reconstruction detail');
assert.deepEqual(metrics(threeScene), exported, 'Three.js and GLB scene content differs');
const a = new Box3().setFromObject(gltfScene); const b = new Box3().setFromObject(threeScene);
assert.ok(a.min.distanceTo(b.min) < 0.001 && a.max.distanceTo(b.max) < 0.001, 'Scene coordinates differ');
assert.throws(() => validateSceneGlb(Buffer.from('invalid')), /Invalid/);
if (process.env.SAVE_SCENE_EXPORTS) {
  const out = path.join(root, 'output/playwright'); await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, `${id}-complete.glb`), glb);
  await fs.writeFile(path.join(out, `${id}-complete.three.json`), json);
}
console.log(`${id}: ${exported.features.length} buildings, ${exported.triangles} triangles, ${exported.balconies} balcony decks; complete GLB (${glb.length} bytes) and Three.js (${json.length} bytes) match`);
