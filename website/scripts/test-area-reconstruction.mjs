import { findAddressBundle, readAddressCatalog } from './address-bundles.mjs';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const modelId = process.argv[2] ?? "muenchner-rathaus-100m";
if (!/^[a-z0-9][a-z0-9-]*$/.test(modelId)) throw Error("Invalid model stem");
const bundle = await findAddressBundle(modelId);
const catalog = await readAddressCatalog(modelId);
const metadata = JSON.parse(
  await fs.readFile(
    path.join(bundle.modelDirectory, `${modelId}.metadata.json`),
    "utf8",
  ),
);
const sourceMesh = JSON.parse(
  await fs.readFile(
    path.join(bundle.modelDirectory, `${modelId}.source-mesh.json`),
    "utf8",
  ),
);
const scratch = path.join(root, ".runtime", "reconstruction-check");
await fs.mkdir(scratch, { recursive: true });
const source = (
  await fs.readFile(path.join(root, "lib/area-reconstruction.ts"), "utf8")
).replaceAll("import.meta.env.BASE_URL", JSON.stringify("/"));
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const modulePath = path.join(scratch, "area-reconstruction.mjs");
await fs.writeFile(modulePath, compiled);
const data = JSON.parse(
  await fs.readFile(path.join(root, catalog.areaSurfacePath), "utf8"),
);
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(url, catalog.areaSurfacePath);
  return { ok: true, json: async () => data };
};
try {
  const { createAreaReconstruction } = await import(pathToFileURL(modulePath));
  const bytes = await fs.readFile(
    path.join(bundle.modelDirectory, `${modelId}.glb`),
  );
  const { scene } = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    "",
  );
  const buildings = [...scene.children];
  const original = buildings.map((m) => ({
    geometry: m.geometry,
    material: m.material,
    positions: Array.from(m.geometry.attributes.position.array),
    triangles: triangleKeys(m.geometry),
    role: m.userData.role,
  }));
  const reconstruction = await createAreaReconstruction(
    scene,
    catalog.areaSurfacePath,
  );
  reconstruction.setVisible(true);
  assert.equal(buildings.length, metadata.buildings.length);
  assert.equal(buildings.length, sourceMesh.buildings.length);
  assert.equal(buildings.length, catalog.buildingCount);
  assert.equal(
    buildings.filter((b) => b.userData.role === "primary").length,
    1,
  );
  for (const b of metadata.buildings.filter((b) => b.role === "neighbor"))
    assert.ok(
      b.maximumDistanceFromPrimaryMetres <=
        metadata.request.neighborDistanceMetres,
    );
  if (data.architectureStyle === "generic") {
    scene.traverse((child) =>
      assert.ok(
        !child.name.includes("Gothic") && !child.name.includes("clock"),
        "Rathaus ornament leaked into generic model",
      ),
    );
  }
  for (const profile of [data.primaryFacade, ...(data.connectedFacades ?? []), ...(data.neighborFacades ?? [])].filter(Boolean)) {
    const primary = buildings.find((b) => b.userData.gml_id === profile.gmlId);
    assert.ok(primary, "Reference profile must match an existing source feature");
    const detail = primary.children.find((c) =>
      c.name.startsWith("Reference-based façade"),
    );
    assert.ok(detail, "Missing reference-based primary façade");
    assert.equal(
      primary.material[0].visible,
      false,
      "Opaque source wall would fill reconstructed openings",
    );
    const wallSurfaces = detail.children.filter(
      (c) => c.name === "Source-plane wall with geometric window openings",
    );
    assert.ok(wallSurfaces.length > 0);
    scene.updateMatrixWorld(true);
    let checked = 0;
    const sourceWall = new THREE.Mesh(original[buildings.indexOf(primary)].geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    sourceWall.updateMatrixWorld();
    for (const face of profile.faces) {
      const normal = new THREE.Vector3(
        face.normal[0],
        0,
        face.normal[1],
      ).normalize();
      const tangent = new THREE.Vector3(normal.z, 0, -normal.x);
      for (const opening of face.openings) {
        if (profile.mergeWallFragments) {
          for (const [x, y] of [[0,0],[-0.45,-0.45],[0.45,-0.45],[-0.40,0.38],[0.40,0.38]]) {
            const point = tangent.clone().multiplyScalar(opening.u + x * opening.w)
              .addScaledVector(normal, face.offset + 0.7).setY(opening.y + y * opening.h);
            const supportRay = new THREE.Raycaster(point, normal.clone().negate(), 0, 1.2);
            assert.ok(supportRay.intersectObject(sourceWall).length, `Photographic opening escapes its wall: ${profile.gmlId}, ${opening.u}/${opening.y}`);
          }
        }
        const origin = tangent
          .clone()
          .multiplyScalar(opening.u)
          .addScaledVector(normal, face.offset + 0.7)
          .setY(opening.y);
        const ray = new THREE.Raycaster(
          origin,
          normal.clone().negate(),
          0,
          1.2,
        );
        assert.equal(
          ray.intersectObjects(wallSurfaces, false).length,
          0,
          `Window center is still covered: ${profile.gmlId}, face ${face.offset}, opening ${opening.u}/${opening.y}`,
        );
        checked++;
      }
    }
    assert.ok(checked > 0, "Reference profile lacks any authored openings");
    sourceWall.material.dispose();
    if (data.neighborFacades?.includes(profile)) {
      assert.equal(primary.userData.role, "neighbor");
      assert.ok(!reconstruction.facadeObjects.includes(primary), "Independent reference neighbour was grouped into the addressed building");
    }
    if (profile.roofFixtures?.length) {
      const roof = primary.children.find(c => c.name === "Photo-reference roof fixtures");
      assert.equal(roof?.userData.fixtureCount, profile.roofFixtures.length, "A roof fixture fell outside its supporting roof plane");
    }
    for (const slab of detail.children.filter((child) => child.userData.sourceTerraceHeight != null)) {
      slab.geometry.computeBoundingBox();
      assert.ok(
        slab.geometry.boundingBox.max.y - slab.userData.sourceTerraceHeight >= 0.02,
        "First-floor deck finish must clear the source terrace plane to prevent z-fighting",
      );
    }
    const expectedBalconies = profile.faces.reduce((count, face) => count + (face.balconies?.length ?? 0), 0);
    assert.equal(
      detail.children.filter((child) => child.name === "Chamfered balcony slab").length,
      expectedBalconies,
      "Every profiled balcony, including rear stacks, must be rendered on its source wall",
    );
  }
  for (let i = 0; i < buildings.length; i++) {
    const mesh = buildings[i];
    assert.deepEqual(
      Array.from(mesh.geometry.attributes.position.array),
      original[i].positions,
      "Source vertex coordinates changed",
    );
    assert.deepEqual(
      triangleKeys(mesh.geometry),
      original[i].triangles,
      "Source triangle topology changed",
    );
    assert.equal(mesh.userData.role, original[i].role);
    assert.ok(
      mesh.children.length >= 2,
      "Missing attached façade or roof detail group",
    );
    mesh.traverse((child) => {
      if (child instanceof THREE.InstancedMesh) {
        for (const n of child.instanceMatrix.array)
          assert.ok(Number.isFinite(n), "Invalid detail transform");
      }
    });
  }
  const surfaceTracks = data.lines.filter((l) =>
    ["tram", "rail", "light_rail", "narrow_gauge"].includes(l.tags.railway),
  );
  assert.equal(reconstruction.stats.railwayTracks, surfaceTracks.length);
  for (const line of surfaceTracks) {
    assert.notEqual(line.tags.tunnel, "yes");
    assert.ok(Number(line.tags.layer ?? 0) >= 0);
    for (const [x, z] of line.points)
      assert.ok(
        x >= data.bounds[0] - 0.001 &&
          x <= data.bounds[2] + 0.001 &&
          z >= data.bounds[1] - 0.001 &&
          z <= data.bounds[3] + 0.001,
        "Rail geometry escaped bounded snapshot",
      );
  }
  if (surfaceTracks.length)
    assert.ok(
      reconstruction.stats.railSleepers > 0,
      "Missing explicit rail sleepers",
    );
  assert.ok(reconstruction.stats.kerbStones > 0);
  for (const bench of reconstruction.environment.userData.benchOrientations ??
    []) {
    const bearing = (bench.bearing * Math.PI) / 180;
    assert.ok(
      Math.abs(bench.front[0] - Math.sin(bearing)) < 1e-8 &&
        Math.abs(bench.front[2] + Math.cos(bearing)) < 1e-8,
      "Bench facing direction reversed in east/up/south coordinates",
    );
    assert.ok(Number.isFinite(bench.bearing));
  }
  const hasEntrance = data.primaryFacade?.faces.some((f) =>
    f.openings.some((o) => o.entrance),
  );
  assert.equal(Boolean(reconstruction.entranceFocus), Boolean(hasEntrance));
  reconstruction.environment.traverse((child) => {
    if (child instanceof THREE.InstancedMesh)
      for (const n of child.instanceMatrix.array)
        assert.ok(Number.isFinite(n), "Invalid street-detail transform");
  });
  assert.ok(reconstruction.stats.windows > 0);
  if (data.architectureStyle === "gothic") {
    assert.ok(reconstruction.stats.pavingStones > 1000);
    assert.ok(reconstruction.stats.roofTiles > 1000);
    assert.ok(data.surfaces.some((s) => s.name === "Marienplatz"));
  }
  for (const s of data.surfaces)
    for (const [x, z] of s.ring) {
      assert.ok(
        x >= data.bounds[0] - 0.001 &&
          x <= data.bounds[2] + 0.001 &&
          z >= data.bounds[1] - 0.001 &&
          z <= data.bounds[3] + 0.001,
      );
    }
  reconstruction.setVisible(true, false);
  assert.equal(reconstruction.environment.visible, true, "Hiding facades must retain surface details");
  for (let i = 0; i < buildings.length; i++) {
    assert.equal(buildings[i].geometry, original[i].geometry);
    assert.ok(buildings[i].children.every((child) => !child.visible));
  }
  reconstruction.setVisible(true, true);
  assert.ok(buildings.every((building) => building.children.every((child) => child.visible)));
  reconstruction.setVisible(false);
  assert.equal(reconstruction.environment.visible, false);
  for (let i = 0; i < buildings.length; i++) {
    assert.equal(buildings[i].geometry, original[i].geometry);
    assert.equal(buildings[i].material, original[i].material);
    for (const child of buildings[i].children)
      assert.equal(child.visible, false);
  }
  reconstruction.dispose();
  console.log(
    JSON.stringify({
      sourceGeometryUnchanged: true,
      modelId,
      rawModeRestored: true,
      ...reconstruction.stats,
    }),
  );
} finally {
  globalThis.fetch = oldFetch;
  await fs.rm(scratch, { recursive: true, force: true });
}
function triangleKeys(geometry) {
  const idx = geometry.index;
  const result = [];
  for (let i = 0; i < idx.count; i += 3)
    result.push([idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)].join(","));
  return result.sort();
}
