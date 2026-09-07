import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createAreaReconstruction } from './area-reconstruction';

// glTF has no material.visible flag. Remove hidden source-wall triangles so
// they cannot fill the geometric window openings in another 3D application.
function visibleGeometry(mesh: THREE.Mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const geometry = mesh.geometry.clone();
  if (!Array.isArray(mesh.material)) return { geometry, material: mesh.material };
  const oldIndex = geometry.index;
  const indices: number[] = [];
  const groups = [...geometry.groups];
  geometry.clearGroups();
  for (const group of groups) {
    if (!materials[group.materialIndex ?? 0]?.visible) continue;
    const start = indices.length;
    for (let i = group.start; i < group.start + group.count; i++) indices.push(oldIndex ? oldIndex.getX(i) : i);
    geometry.addGroup(start, indices.length - start, group.materialIndex);
  }
  geometry.setIndex(indices);
  return { geometry, material: mesh.material };
}

export async function buildBuildingFacade(glb: ArrayBuffer, areaBytes: Uint8Array<ArrayBuffer>, options: { complete?: boolean; format?: 'glb' | 'three' } = {}) {
  const area = JSON.parse(new TextDecoder().decode(areaBytes));
  const { scene } = await new GLTFLoader().parseAsync(glb, '');
  const connected = new Set((area.connectedFacades ?? []).map((profile: { gmlId: string }) => profile.gmlId));
  for (const child of [...scene.children]) {
    if (!options.complete && child.userData.role !== 'primary' && !connected.has(child.userData.gml_id)) scene.remove(child);
  }
  if (!scene.children.some(child => child.userData.role === 'primary')) throw new Error('Main building is missing');
  const surfaceUrl = URL.createObjectURL(new Blob([areaBytes], { type: 'application/json' }));
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  let reconstruction: Awaited<ReturnType<typeof createAreaReconstruction>> | undefined;
  try {
    reconstruction = await createAreaReconstruction(scene, surfaceUrl, { includeEnvironment: Boolean(options.complete) });
    reconstruction.setVisible(true);
    if (options.complete) scene.add(reconstruction.environment);
    const output = new THREE.Scene();
    output.name = options.complete ? 'Complete neighbourhood with modeled facades and surroundings' : 'Main building with modeled facades';
    output.userData = {
      reconstruction: 'Illustrative facade geometry; original LoD2 is supplied separately.',
      attribution: 'Bayerische Vermessungsverwaltung – www.geodaten.bayern.de · CC BY 4.0',
      coordinateAxes: 'X east, Y up, Z south; metres',
      ...(options.complete ? { mapAttribution: '© OpenStreetMap contributors · ODbL', referenceNotes: area } : {}),
    };
    scene.updateMatrixWorld(true);
    for (const feature of scene.children) {
      const group = new THREE.Group();
      group.name = feature.name;
      group.userData = { ...feature.userData };
      output.add(group);
      feature.traverseVisible(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const originalMaterials = Array.isArray(object.material) ? object.material : [object.material];
        if (originalMaterials.every(material => !material.visible)) return;
        const visible = visibleGeometry(object);
        let geometry = visible.geometry;
        if (object instanceof THREE.InstancedMesh) {
          // Bake instances into ordinary triangles for applications without
          // EXT_mesh_gpu_instancing support (including common GLB importers).
          const instances: THREE.BufferGeometry[] = [];
          const matrix = new THREE.Matrix4();
          for (let i = 0; i < object.count; i++) {
            object.getMatrixAt(i, matrix);
            instances.push(geometry.clone().applyMatrix4(matrix));
          }
          const merged = mergeGeometries(instances);
          for (const instance of instances) instance.dispose();
          geometry.dispose();
          if (!merged) throw new Error('Could not bake facade instances');
          geometry = merged;
        }
        geometry.applyMatrix4(object.matrixWorld);
        geometry.normalizeNormals();
        const normals = geometry.getAttribute('normal');
        // Match glTF's unit-normal requirement for unused/degenerate vertices.
        for (let i = 0; i < (normals?.count ?? 0); i++) {
          if (normals.getX(i) === 0 && normals.getY(i) === 0 && normals.getZ(i) === 0) normals.setX(i, 1);
        }
        geometries.add(geometry);
        const mesh = new THREE.Mesh(geometry, visible.material);
        mesh.name = object.name;
        // Feature identity lives on the containing group, not each detail mesh.
        mesh.userData = object === feature ? {} : { ...object.userData };
        group.add(mesh);
      });
    }
    if (options.format === 'three') return new TextEncoder().encode(JSON.stringify(output.toJSON()));
    const result = await new GLTFExporter().parseAsync(output, { binary: true, onlyVisible: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('Could not export building GLB');
    return new Uint8Array(result);
  } finally {
    URL.revokeObjectURL(surfaceUrl);
    scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    reconstruction?.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}
