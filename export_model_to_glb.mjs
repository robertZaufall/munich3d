#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function usage() {
  return `Usage:
  node export_model_to_glb.mjs INPUT.source-mesh.json INPUT.metadata.json OUTPUT.glb

Builds a web-ready GLB directly from a munich3d source mesh and its metadata.`;
}

function fail(message) {
  throw new Error(message);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a finite number`);
  return number;
}

function floatBuffer(values) {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function indexBuffer(values, componentType) {
  const bytes = componentType === UNSIGNED_SHORT ? 2 : 4;
  const buffer = Buffer.allocUnsafe(values.length * bytes);
  values.forEach((value, index) => {
    if (componentType === UNSIGNED_SHORT) buffer.writeUInt16LE(value, index * bytes);
    else buffer.writeUInt32LE(value, index * bytes);
  });
  return buffer;
}

function normalizedNormal(normal, horizontalScale) {
  const x = finiteNumber(normal?.[0], 'normal.x') / horizontalScale;
  const y = finiteNumber(normal?.[2], 'normal.z');
  const z = -finiteNumber(normal?.[1], 'normal.y') / horizontalScale;
  const length = Math.hypot(x, y, z);
  return length > 0 ? [x / length, y / length, z / length] : [0, 1, 0];
}

function nodeName(building, metadataBuilding) {
  const role = metadataBuilding.role;
  const identifier =
    metadataBuilding.attributes?.gml_id ||
    metadataBuilding.attributes?.OBJECTID ||
    building.featureId;
  return `${role}_${identifier}`.replace(/[^A-Za-z0-9_.-]+/gu, '_');
}

function alignFour(value) {
  return (value + 3) & ~3;
}

function buildGlb(source, metadata) {
  if (!Array.isArray(source.buildings) || source.buildings.length === 0) {
    fail('Source mesh contains no buildings');
  }
  if (!Array.isArray(metadata.buildings)) fail('Metadata contains no buildings');
  if (metadata.buildings.length !== source.buildings.length) {
    fail('Source mesh and metadata building counts differ');
  }

  const transformation = metadata.objTransformation;
  const origin = transformation?.originEpsg3857;
  const horizontalScale = finiteNumber(
    transformation?.horizontalScaleFromWebMercatorToLocalMetres,
    'horizontal scale',
  );
  const verticalOrigin = finiteNumber(
    transformation?.verticalOriginMetres,
    'vertical origin',
  );
  if (!Array.isArray(origin) || origin.length !== 2) {
    fail('Metadata lacks the EPSG:3857 origin');
  }
  const originX = finiteNumber(origin[0], 'origin.x');
  const originY = finiteNumber(origin[1], 'origin.y');

  const metadataByFeatureId = new Map(
    metadata.buildings.map((building) => [String(building.featureId), building]),
  );
  const binaryParts = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  let binaryLength = 0;

  function addBufferView(buffer, target) {
    const alignedOffset = alignFour(binaryLength);
    if (alignedOffset > binaryLength) {
      binaryParts.push(Buffer.alloc(alignedOffset - binaryLength));
      binaryLength = alignedOffset;
    }
    const index = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: binaryLength,
      byteLength: buffer.length,
      target,
    });
    binaryParts.push(buffer);
    binaryLength += buffer.length;
    return index;
  }

  function addAccessor(bufferView, componentType, count, type, options = {}) {
    const accessor = { bufferView, componentType, count, type, ...options };
    accessors.push(accessor);
    return accessors.length - 1;
  }

  for (const building of source.buildings) {
    const metadataBuilding = metadataByFeatureId.get(String(building.featureId));
    if (!metadataBuilding) {
      fail(`No metadata record for source feature ${building.featureId}`);
    }
    if (!['primary', 'neighbor'].includes(metadataBuilding.role)) {
      fail(`Feature ${building.featureId} has an invalid role`);
    }
    if (building.role !== metadataBuilding.role) {
      fail(`Feature ${building.featureId} has inconsistent source and metadata roles`);
    }
    if (!Array.isArray(building.vertices) || building.vertices.length === 0) {
      fail(`Feature ${building.featureId} contains no vertices`);
    }
    if (!Array.isArray(building.triangles) || building.triangles.length === 0) {
      fail(`Feature ${building.featureId} contains no triangles`);
    }
    if (
      building.triangles.some(
        (triangle) =>
          !Array.isArray(triangle) ||
          triangle.length !== 3 ||
          triangle.some((index) => !Number.isInteger(index)),
      )
    ) {
      fail(`Feature ${building.featureId} contains an invalid triangle`);
    }

    const positions = [];
    const normals = [];
    const textureCoordinates = [];
    const colors = [];
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];

    for (const vertex of building.vertices) {
      const sourcePosition = vertex.position;
      if (!Array.isArray(sourcePosition) || sourcePosition.length !== 3) {
        fail(`Feature ${building.featureId} has an invalid position`);
      }
      const position = [
        (finiteNumber(sourcePosition[0], 'position.x') - originX) * horizontalScale,
        finiteNumber(sourcePosition[2], 'position.z') - verticalOrigin,
        -(finiteNumber(sourcePosition[1], 'position.y') - originY) * horizontalScale,
      ];
      positions.push(...position);
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis], position[axis]);
        maximum[axis] = Math.max(maximum[axis], position[axis]);
      }
      normals.push(...normalizedNormal(vertex.normal, horizontalScale));
      textureCoordinates.push(
        finiteNumber(vertex.uv?.[0] ?? 0, 'uv.u'),
        finiteNumber(vertex.uv?.[1] ?? 0, 'uv.v'),
      );
      const color = vertex.color ?? [255, 255, 255, 255];
      for (let channel = 0; channel < 4; channel += 1) {
        colors.push(Math.max(0, Math.min(255, Math.round(color[channel] ?? 255))));
      }
    }

    const indices = building.triangles.flat();
    const maximumIndex = Math.max(...indices);
    const minimumIndex = Math.min(...indices);
    if (minimumIndex < 0 || maximumIndex >= building.vertices.length) {
      fail(`Feature ${building.featureId} has an out-of-range triangle index`);
    }
    const indexComponentType = maximumIndex <= 65535 ? UNSIGNED_SHORT : UNSIGNED_INT;
    const positionView = addBufferView(floatBuffer(positions), ARRAY_BUFFER);
    const normalView = addBufferView(floatBuffer(normals), ARRAY_BUFFER);
    const textureView = addBufferView(floatBuffer(textureCoordinates), ARRAY_BUFFER);
    const colorView = addBufferView(Buffer.from(colors), ARRAY_BUFFER);
    const indicesView = addBufferView(
      indexBuffer(indices, indexComponentType),
      ELEMENT_ARRAY_BUFFER,
    );
    const positionAccessor = addAccessor(
      positionView,
      FLOAT,
      building.vertices.length,
      'VEC3',
      { min: minimum, max: maximum },
    );
    const normalAccessor = addAccessor(
      normalView,
      FLOAT,
      building.vertices.length,
      'VEC3',
    );
    const textureAccessor = addAccessor(
      textureView,
      FLOAT,
      building.vertices.length,
      'VEC2',
    );
    const colorAccessor = addAccessor(
      colorView,
      UNSIGNED_BYTE,
      building.vertices.length,
      'VEC4',
      { normalized: true },
    );
    const indicesAccessor = addAccessor(
      indicesView,
      indexComponentType,
      indices.length,
      'SCALAR',
      { min: [minimumIndex], max: [maximumIndex] },
    );
    const name = nodeName(building, metadataBuilding);
    const distanceFromPrimary = finiteNumber(
      metadataBuilding.distanceFromPrimaryMetres,
      `feature ${building.featureId} distance`,
    );
    const maximumDistanceFromPrimary = Number(
      metadataBuilding.maximumDistanceFromPrimaryMetres,
    );
    const meshIndex = meshes.length;
    meshes.push({
      name: `${name}_mesh`,
      primitives: [
        {
          attributes: {
            POSITION: positionAccessor,
            NORMAL: normalAccessor,
            TEXCOORD_0: textureAccessor,
            COLOR_0: colorAccessor,
          },
          indices: indicesAccessor,
          material: metadataBuilding.role === 'primary' ? 0 : 1,
        },
      ],
    });
    nodes.push({
      name,
      mesh: meshIndex,
      extras: {
        role: metadataBuilding.role,
        distance_from_primary_m: distanceFromPrimary,
        ...(Number.isFinite(maximumDistanceFromPrimary)
          ? { maximum_distance_from_primary_m: maximumDistanceFromPrimary }
          : {}),
        gml_id: metadataBuilding.attributes?.gml_id ?? '',
        OBJECTID:
          metadataBuilding.attributes?.OBJECTID ?? metadataBuilding.featureId,
      },
    });
  }

  const primaryCount = nodes.filter((node) => node.extras.role === 'primary').length;
  const neighborCount = nodes.length - primaryCount;
  if (primaryCount !== 1) fail(`Expected one primary building, found ${primaryCount}`);
  if (
    metadata.selection?.buildingCount !== nodes.length ||
    metadata.selection?.neighborCount !== neighborCount
  ) {
    fail('Generated node counts disagree with metadata selection counts');
  }

  const paddedBinaryLength = alignFour(binaryLength);
  if (paddedBinaryLength > binaryLength) {
    binaryParts.push(Buffer.alloc(paddedBinaryLength - binaryLength));
    binaryLength = paddedBinaryLength;
  }
  const binary = Buffer.concat(binaryParts, binaryLength);
  const gltf = {
    asset: {
      version: '2.0',
      generator: 'munich3d direct Node.js GLB exporter',
      copyright: `${metadata.source?.attribution ?? ''} — ${metadata.source?.license ?? ''}`,
    },
    scene: 0,
    scenes: [
      {
        name: 'Scene',
        nodes: nodes.map((_, index) => index),
        extras: {
          address:
            metadata.geocode?.matchedAddress ?? metadata.request?.address ?? '',
          neighbor_distance_m: metadata.request?.neighborDistanceMetres,
          attribution: metadata.source?.attribution ?? '',
          license: metadata.source?.license ?? '',
        },
      },
    ],
    nodes,
    meshes,
    materials: [
      {
        name: 'Primary building',
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.68, 0.63, 0.54, 1],
          metallicFactor: 0,
          roughnessFactor: 0.72,
        },
      },
      {
        name: 'Neighbor buildings',
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.29, 0.42, 0.46, 1],
          metallicFactor: 0,
          roughnessFactor: 0.82,
        },
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };

  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const paddedJsonLength = alignFour(json.length);
  const paddedJson = Buffer.alloc(paddedJsonLength, 0x20);
  json.copy(paddedJson);
  const totalLength = 12 + 8 + paddedJson.length + 8 + binary.length;
  const output = Buffer.allocUnsafe(totalLength);
  output.write('glTF', 0, 4, 'ascii');
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(paddedJson.length, 12);
  output.writeUInt32LE(JSON_CHUNK, 16);
  paddedJson.copy(output, 20);
  const binaryHeader = 20 + paddedJson.length;
  output.writeUInt32LE(binary.length, binaryHeader);
  output.writeUInt32LE(BIN_CHUNK, binaryHeader + 4);
  binary.copy(output, binaryHeader + 8);
  return { output, buildingCount: nodes.length, triangleCount: source.buildings.reduce((total, building) => total + building.triangles.length, 0) };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    console.log(usage());
    return;
  }
  if (arguments_.length !== 3) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const [sourcePath, metadataPath, outputPath] = arguments_.map((value) =>
    path.resolve(value),
  );
  const [source, metadata] = await Promise.all([
    readFile(sourcePath, 'utf8').then(JSON.parse),
    readFile(metadataPath, 'utf8').then(JSON.parse),
  ]);
  const result = buildGlb(source, metadata);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.output);
  console.log(
    JSON.stringify({
      source: sourcePath,
      metadata: metadataPath,
      output: outputPath,
      buildings: result.buildingCount,
      triangles: result.triangleCount,
      bytes: result.output.length,
    }),
  );
}

await main();
