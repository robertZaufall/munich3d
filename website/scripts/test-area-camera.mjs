import { findAddressBundle, readAddressCatalog } from './address-bundles.mjs';
import path from 'node:path';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
const root = new URL("../", import.meta.url);
const modelId = process.argv[2] ?? "muenchner-rathaus-100m";
if (!/^[a-z0-9][a-z0-9-]*$/.test(modelId)) throw Error("Invalid model stem");
const bundle = await findAddressBundle(modelId);
const catalog = await readAddressCatalog(modelId);
const temp = new URL(".runtime/fit-area-camera-test.mjs", root);
await fs.mkdir(new URL(".runtime/", root), { recursive: true });
const source = await fs.readFile(
  new URL("lib/fit-area-camera.ts", root),
  "utf8",
);
await fs.writeFile(
  temp,
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText,
);
try {
  const { fitAreaCamera, fitGroundPlate } = await import(temp.href);
  // A sparse footprint must not inherit the empty bounding-box corners or
  // the camera's perspective offset. Height must not enlarge its ground.
  const footprint = [new THREE.Vector3(-20, 0, 0), new THREE.Vector3(20, 0, 0),
    new THREE.Vector3(0, 100, -10), new THREE.Vector3(0, 0, 10)];
  const plate = fitGroundPlate(footprint);
  assert.deepEqual(plate.center.toArray(), [0, 0, 0]);
  assert.ok(Math.abs(plate.radius - 20.8) < 1e-9);
  const shifted = fitGroundPlate(footprint.map(p => p.clone().add(new THREE.Vector3(70, 200, -30))));
  assert.deepEqual(shifted.center.toArray(), [70, 0, -30]);
  assert.equal(shifted.radius, plate.radius);
  assert.ok(fitGroundPlate([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)]).radius < 2);
  const bytes = await fs.readFile(path.join(bundle.modelDirectory, `${modelId}.glb`));
  const { scene } = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    "",
  );
  const points = [];
  for (const mesh of scene.children) {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++)
      points.push(new THREE.Vector3().fromBufferAttribute(positions, i));
  }
  const data = JSON.parse(
    await fs.readFile(
      new URL(catalog.areaSurfacePath.slice(1), root),
      "utf8",
    ),
  );
  for (const x of [data.bounds[0], data.bounds[2]])
    for (const z of [data.bounds[1], data.bounds[3]])
      for (const y of [-2, 14]) points.push(new THREE.Vector3(x, y, z));
  for (const aspect of [2, 1, 0.6]) {
    const fit = fitAreaCamera(
      points,
      new THREE.Vector3(0.3, 0.95, 1.3),
      38,
      aspect,
    );
    const camera = new THREE.PerspectiveCamera(38, aspect, 0.05, 5000);
    camera.position.copy(fit.position);
    camera.lookAt(fit.target);
    camera.updateMatrixWorld(true);
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of points) {
      const v = p.clone().project(camera);
      bounds[0] = Math.min(bounds[0], v.x);
      bounds[1] = Math.min(bounds[1], v.y);
      bounds[2] = Math.max(bounds[2], v.x);
      bounds[3] = Math.max(bounds[3], v.y);
    }
    assert.ok(
      Math.abs(bounds[0] + bounds[2]) < 1e-6,
      "Area not horizontally centered",
    );
    assert.ok(
      Math.abs(bounds[1] + bounds[3]) < 1e-6,
      "Area not vertically centered",
    );
    assert.ok(
      bounds.every((v) => Math.abs(v) <= 0.900001),
      "Geometry clipped",
    );
    assert.ok(
      Math.abs(Math.max(...bounds.map(Math.abs)) - 0.9) < 1e-6,
      "Camera too far away",
    );
    console.log(JSON.stringify({ aspect, bounds, distance: fit.distance }));
  }
} finally {
  await fs.unlink(fileURLToPath(temp));
}
