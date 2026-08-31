#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ITEM_ID = "afce63c0ee9a4a33b2c4ebd29a8e71ef";
const DEFAULT_NEIGHBOR_DISTANCE_METRES = 35;
const DEFAULT_TARGET_SEARCH_DISTANCE_METRES = 25;
const GEOCODER_URL =
  "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";
const EARTH_RADIUS = 6378137;

function usage() {
  return `Usage:
  node extract_buildings.mjs --address "Münchner Rathaus, Marienplatz 8, 80331 München, Germany" [options]

Options:
  --address <text>                  Address to geocode (required unless --coordinates is used)
  --coordinates <lat,lon>          Use explicit coordinates instead of geocoding
  --neighbor-distance <metres>     Maximum distance of a complete neighbor from the primary (default: 35)
  --target-search-distance <m>     Maximum address-point-to-building fallback (default: 25)
  --output <directory>             Output directory (default: .work/<address-slug>)
  --item-id <id>                   ArcGIS Scene Service item ID
  --help                            Show this help

The output OBJ contains the addressed building and every neighboring building
whose complete horizontal geometry stays within --neighbor-distance of the primary building.`;
}

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, received: ${value}`);
  }
  return parsed;
}

function parseCoordinates(value) {
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (
    parts.length !== 2 ||
    !Number.isFinite(parts[0]) ||
    !Number.isFinite(parts[1]) ||
    Math.abs(parts[0]) > 90 ||
    Math.abs(parts[1]) > 180
  ) {
    throw new Error(`--coordinates must be formatted as latitude,longitude: ${value}`);
  }
  return { latitude: parts[0], longitude: parts[1] };
}

function parseArgs(argv) {
  const options = {
    address: null,
    coordinates: null,
    neighborDistance: DEFAULT_NEIGHBOR_DISTANCE_METRES,
    targetSearchDistance: DEFAULT_TARGET_SEARCH_DISTANCE_METRES,
    output: null,
    itemId: DEFAULT_ITEM_ID,
    help: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      return next;
    };
    if (argument === "--address") options.address = value();
    else if (argument === "--coordinates") options.coordinates = parseCoordinates(value());
    else if (argument === "--neighbor-distance" || argument === "--radius") {
      options.neighborDistance = parseNumber(value(), argument);
    } else if (argument === "--target-search-distance") {
      options.targetSearchDistance = parseNumber(value(), argument);
    } else if (argument === "--output") options.output = value();
    else if (argument === "--item-id") options.itemId = value();
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  if (!options.address && positional.length > 0) options.address = positional.join(" ");
  if (!options.help && !options.address && !options.coordinates) {
    throw new Error("Provide --address or --coordinates");
  }
  return options;
}

function slugify(value) {
  const slug = value
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return slug || "building-model";
}

function webMercator({ longitude, latitude }) {
  return [
    (EARTH_RADIUS * longitude * Math.PI) / 180,
    EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)),
  ];
}

async function fetchChecked(url, type = "json") {
  const response = await fetch(url, { headers: { "User-Agent": "munich3d-extractor/1.0" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  if (type === "buffer") return Buffer.from(await response.arrayBuffer());
  const result = await response.json();
  if (result.error) {
    throw new Error(`${result.error.message ?? "ArcGIS error"}: ${url}`);
  }
  return result;
}

async function geocodeAddress(address) {
  const url = new URL(GEOCODER_URL);
  url.searchParams.set("SingleLine", address);
  url.searchParams.set("f", "json");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("maxLocations", "5");
  url.searchParams.set("forStorage", "false");
  url.searchParams.set("outFields", "Match_addr,Addr_type,City,Postal,CountryCode");
  const result = await fetchChecked(url);
  const candidate = result.candidates?.[0];
  if (!candidate) throw new Error(`No geocoding result for: ${address}`);
  if (candidate.score < 80) {
    throw new Error(`Geocoding score ${candidate.score} is too low for: ${address}`);
  }
  return {
    input: address,
    matchedAddress: candidate.address,
    score: candidate.score,
    attributes: candidate.attributes,
    location: {
      latitude: candidate.location.y,
      longitude: candidate.location.x,
    },
  };
}

function circleIntersectsSphere(point, radius, sphere) {
  return Math.hypot(sphere[0] - point[0], sphere[1] - point[1]) <= sphere[3] + radius;
}

async function findCandidateLeaves(layerUrl, point, radius, nodeCache) {
  const leaves = new Map();
  async function getNode(id) {
    if (!nodeCache.has(id)) nodeCache.set(id, fetchChecked(`${layerUrl}/nodes/${id}`));
    return nodeCache.get(id);
  }
  async function visit(id) {
    const node = await getNode(id);
    const children = (node.children ?? []).filter((child) =>
      circleIntersectsSphere(point, radius, child.mbs),
    );
    if (children.length === 0) {
      if (node.geometryData) leaves.set(String(node.id), node);
      return;
    }
    await Promise.all(children.map((child) => visit(String(child.id))));
  }
  await visit("root");
  return [...leaves.values()];
}

function parseGeometry(buffer, center) {
  const vertexCount = buffer.readUInt32LE(0);
  const featureCount = buffer.readUInt32LE(4);
  const positionOffset = 8;
  const normalOffset = positionOffset + vertexCount * 12;
  const uvOffset = normalOffset + vertexCount * 12;
  const colorOffset = uvOffset + vertexCount * 8;
  const featureIdOffset = colorOffset + vertexCount * 4;
  const faceRangeOffset = featureIdOffset + featureCount * 8;
  const expectedSize = faceRangeOffset + featureCount * 8;
  if (buffer.length !== expectedSize) {
    throw new Error(`Unexpected I3S geometry size: ${buffer.length} != ${expectedSize}`);
  }

  const vertex = (index) => ({
    position: [
      center[0] + buffer.readFloatLE(positionOffset + index * 12),
      center[1] + buffer.readFloatLE(positionOffset + index * 12 + 4),
      center[2] + buffer.readFloatLE(positionOffset + index * 12 + 8),
    ],
    normal: [
      buffer.readFloatLE(normalOffset + index * 12),
      buffer.readFloatLE(normalOffset + index * 12 + 4),
      buffer.readFloatLE(normalOffset + index * 12 + 8),
    ],
    uv: [
      buffer.readFloatLE(uvOffset + index * 8),
      buffer.readFloatLE(uvOffset + index * 8 + 4),
    ],
    color: [...buffer.subarray(colorOffset + index * 4, colorOffset + index * 4 + 4)],
  });

  const features = [];
  for (let row = 0; row < featureCount; row += 1) {
    const startFace = buffer.readUInt32LE(faceRangeOffset + row * 8);
    const endFace = buffer.readUInt32LE(faceRangeOffset + row * 8 + 4);
    const vertices = [];
    for (let face = startFace; face <= endFace; face += 1) {
      vertices.push(vertex(face * 3), vertex(face * 3 + 1), vertex(face * 3 + 2));
    }
    features.push({
      row,
      featureId: buffer.readBigUInt64LE(featureIdOffset + row * 8).toString(),
      faceRange: [startFace, endFace],
      vertices,
    });
  }
  return { vertexCount, featureCount, features };
}

async function loadFeatures(layerUrl, leaves, geometryCache) {
  const loaded = await Promise.all(
    leaves.map(async (node) => {
      const nodeId = String(node.id);
      if (!geometryCache.has(nodeId)) {
        geometryCache.set(
          nodeId,
          fetchChecked(`${layerUrl}/nodes/${nodeId}/geometries/0`, "buffer").then((buffer) =>
            parseGeometry(buffer, node.mbs),
          ),
        );
      }
      const geometry = await geometryCache.get(nodeId);
      return geometry.features.map((feature) => ({ node, geometry, feature }));
    }),
  );
  const unique = new Map();
  for (const entry of loaded.flat()) {
    if (!unique.has(entry.feature.featureId)) unique.set(entry.feature.featureId, entry);
  }
  return [...unique.values()];
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTriangle(point, a, b, c) {
  if (Math.abs(cross(a, b, c)) < 1e-9) return false;
  const d1 = cross(a, b, point);
  const d2 = cross(b, c, point);
  const d3 = cross(c, a, point);
  const epsilon = 1e-7;
  const hasNegative = d1 < -epsilon || d2 < -epsilon || d3 < -epsilon;
  const hasPositive = d1 > epsilon || d2 > epsilon || d3 > epsilon;
  return !(hasNegative && hasPositive);
}

function pointSegmentDistanceSquared(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (point[0] - a[0]) ** 2 + (point[1] - a[1]) ** 2;
  const t = Math.max(
    0,
    Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared),
  );
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return (point[0] - x) ** 2 + (point[1] - y) ** 2;
}

function onSegment(a, b, point) {
  const epsilon = 1e-7;
  return (
    Math.abs(cross(a, b, point)) <= epsilon &&
    point[0] >= Math.min(a[0], b[0]) - epsilon &&
    point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon &&
    point[1] <= Math.max(a[1], b[1]) + epsilon
  );
}

function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if ((abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0)) return true;
  return (
    (Math.abs(abC) < 1e-7 && onSegment(a, b, c)) ||
    (Math.abs(abD) < 1e-7 && onSegment(a, b, d)) ||
    (Math.abs(cdA) < 1e-7 && onSegment(c, d, a)) ||
    (Math.abs(cdB) < 1e-7 && onSegment(c, d, b))
  );
}

function segmentDistanceSquared(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistanceSquared(a, c, d),
    pointSegmentDistanceSquared(b, c, d),
    pointSegmentDistanceSquared(c, a, b),
    pointSegmentDistanceSquared(d, a, b),
  );
}

function triangleDistanceSquared(a, b) {
  if (
    pointInTriangle(a[0], ...b) ||
    pointInTriangle(b[0], ...a) ||
    pointInTriangle(a[1], ...b) ||
    pointInTriangle(b[1], ...a) ||
    pointInTriangle(a[2], ...b) ||
    pointInTriangle(b[2], ...a)
  ) {
    return 0;
  }
  let minimum = Infinity;
  for (let left = 0; left < 3; left += 1) {
    for (let right = 0; right < 3; right += 1) {
      minimum = Math.min(
        minimum,
        segmentDistanceSquared(
          a[left],
          a[(left + 1) % 3],
          b[right],
          b[(right + 1) % 3],
        ),
      );
      if (minimum === 0) return 0;
    }
  }
  return minimum;
}

function featureTriangles2d(feature) {
  const triangles = [];
  for (let index = 0; index < feature.vertices.length; index += 3) {
    triangles.push([
      feature.vertices[index].position.slice(0, 2),
      feature.vertices[index + 1].position.slice(0, 2),
      feature.vertices[index + 2].position.slice(0, 2),
    ]);
  }
  return triangles;
}

function trianglesPointDistance(triangles, point) {
  let minimum = Infinity;
  for (const triangle of triangles) {
    if (pointInTriangle(point, ...triangle)) return 0;
    for (let edge = 0; edge < 3; edge += 1) {
      minimum = Math.min(
        minimum,
        pointSegmentDistanceSquared(point, triangle[edge], triangle[(edge + 1) % 3]),
      );
    }
  }
  return Math.sqrt(minimum);
}

function featurePointDistance(feature, point) {
  return trianglesPointDistance(featureTriangles2d(feature), point);
}

function featureMaximumVertexDistanceFromFeature(primary, neighbor) {
  const primaryTriangles = featureTriangles2d(primary);
  return Math.max(
    ...neighbor.vertices.map(({ position }) =>
      trianglesPointDistance(primaryTriangles, position.slice(0, 2)),
    ),
  );
}

function bounds(vertices) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const { position } of vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], position[axis]);
      maximum[axis] = Math.max(maximum[axis], position[axis]);
    }
  }
  return { minimum, maximum };
}

function featureDistance(left, right) {
  let minimum = Infinity;
  const leftTriangles = featureTriangles2d(left);
  const rightTriangles = featureTriangles2d(right);
  for (const leftTriangle of leftTriangles) {
    for (const rightTriangle of rightTriangles) {
      const distance = triangleDistanceSquared(leftTriangle, rightTriangle);
      if (distance < minimum || !Number.isFinite(minimum)) minimum = distance;
      if (minimum === 0) return 0;
    }
  }
  return Math.sqrt(minimum);
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function parseAttribute(buffer, storage, row) {
  const count = buffer.readUInt32LE(0);
  if (row >= count) throw new Error(`Attribute row ${row} is outside count ${count}`);
  const valueType = storage.attributeValues.valueType;
  if (valueType === "String") {
    let offset = 8 + count * 4;
    for (let index = 0; index < row; index += 1) offset += buffer.readUInt32LE(8 + index * 4);
    const length = buffer.readUInt32LE(8 + row * 4);
    return buffer.subarray(offset, offset + length).toString("utf8").replace(/\0+$/u, "");
  }
  if (valueType === "Oid32" || valueType === "UInt32") return buffer.readUInt32LE(4 + row * 4);
  if (valueType === "Int32") return buffer.readInt32LE(4 + row * 4);
  if (valueType === "Float64") return buffer.readDoubleLE(align(4, 8) + row * 8);
  if (valueType === "Float32") return buffer.readFloatLE(4 + row * 4);
  throw new Error(`Unsupported I3S attribute type: ${valueType}`);
}

async function extractAttributes(layerUrl, nodeId, row, layer, attributeCache) {
  const pairs = await Promise.all(
    layer.fields.map(async (field) => {
      const storage = layer.attributeStorageInfo.find((entry) => entry.name === field.name);
      if (!storage) return null;
      const cacheKey = `${nodeId}:${storage.key}`;
      if (!attributeCache.has(cacheKey)) {
        attributeCache.set(
          cacheKey,
          fetchChecked(`${layerUrl}/nodes/${nodeId}/attributes/${storage.key}/0`, "buffer"),
        );
      }
      return [field.name, parseAttribute(await attributeCache.get(cacheKey), storage, row)];
    }),
  );
  return Object.fromEntries(pairs.filter(Boolean));
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

function objectName(role, attributes, featureId) {
  const label = attributes.gml_id || `OBJECTID_${featureId}`;
  return `${role}_${label}`.replace(/[^A-Za-z0-9_.-]+/gu, "_");
}

function createObj(buildings, origin, horizontalScale, groundHeight, address, neighborDistance) {
  const lines = [
    `# ${address}`,
    `# Addressed building plus neighbors whose complete geometry stays within ${neighborDistance} m of the primary`,
    "# Local metric coordinates: X=east, Y=north, Z=up",
    `# EPSG:3857 origin: ${origin[0]} ${origin[1]}; vertical origin: ${groundHeight} m`,
    `# Horizontal Web Mercator scale correction: ${horizontalScale}`,
  ];
  let vertexOffset = 1;
  for (const building of buildings) {
    const { feature } = building.entry;
    lines.push(`o ${objectName(building.role, building.attributes, feature.featureId)}`);
    for (const vertex of feature.vertices) {
      const [x, y, z] = vertex.position;
      const [r, g, b] = vertex.color.map((value) => value / 255);
      lines.push(
        `v ${((x - origin[0]) * horizontalScale).toFixed(6)} ${((y - origin[1]) * horizontalScale).toFixed(6)} ${(z - groundHeight).toFixed(6)} ${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`,
      );
    }
    for (const { uv } of feature.vertices) lines.push(`vt ${uv[0]} ${uv[1]}`);
    for (const { normal } of feature.vertices) {
      const corrected = normalize([
        normal[0] / horizontalScale,
        normal[1] / horizontalScale,
        normal[2],
      ]);
      lines.push(`vn ${corrected[0]} ${corrected[1]} ${corrected[2]}`);
    }
    for (let index = 0; index < feature.vertices.length; index += 3) {
      const a = vertexOffset + index;
      lines.push(`f ${a}/${a}/${a} ${a + 1}/${a + 1}/${a + 1} ${a + 2}/${a + 2}/${a + 2}`);
    }
    vertexOffset += feature.vertices.length;
  }
  return `${lines.join("\n")}\n`;
}

function buildingGeometryRecord(building) {
  const { node, geometry, feature } = building.entry;
  return {
    role: building.role,
    distanceFromPrimaryMetres: building.distanceMetres,
    maximumDistanceFromPrimaryMetres: building.maximumDistanceFromPrimaryMetres,
    featureId: feature.featureId,
    nodeId: String(node.id),
    nodeCenter: node.mbs.slice(0, 3),
    nodeLevel: node.level,
    nodeFeatureCount: geometry.featureCount,
    nodeVertexCount: geometry.vertexCount,
    featureRow: feature.row,
    faceRange: feature.faceRange,
    boundsEpsg3857: bounds(feature.vertices),
    triangles: Array.from({ length: feature.vertices.length / 3 }, (_, index) => [
      index * 3,
      index * 3 + 1,
      index * 3 + 2,
    ]),
    vertices: feature.vertices,
  };
}

function buildingMetadataRecord(building) {
  const { node, feature } = building.entry;
  return {
    role: building.role,
    distanceFromPrimaryMetres: building.distanceMetres,
    maximumDistanceFromPrimaryMetres: building.maximumDistanceFromPrimaryMetres,
    nodeId: String(node.id),
    featureRow: feature.row,
    featureId: feature.featureId,
    triangleCount: feature.vertices.length / 3,
    vertexCount: feature.vertices.length,
    boundsEpsg3857: bounds(feature.vertices),
    attributes: building.attributes,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const geocode = options.coordinates
    ? null
    : await geocodeAddress(options.address);
  const location = options.coordinates ?? geocode.location;
  const address = options.address ?? `${location.latitude},${location.longitude}`;
  const mapPoint = webMercator(location);
  const horizontalScale = Math.cos((location.latitude * Math.PI) / 180);
  const itemUrl = `https://www.arcgis.com/sharing/rest/content/items/${options.itemId}?f=json`;
  const item = await fetchChecked(itemUrl);
  if (!item.url) throw new Error(`ArcGIS item ${options.itemId} has no service URL`);
  const sceneUrl = item.url.replace(/\/$/u, "");
  const layerUrl = `${sceneUrl}/layers/0`;
  const [service, layer] = await Promise.all([
    fetchChecked(`${sceneUrl}?f=json`),
    fetchChecked(`${layerUrl}?f=json`),
  ]);

  const nodeCache = new Map();
  const geometryCache = new Map();
  const attributeCache = new Map();
  const targetRadiusSource = options.targetSearchDistance / horizontalScale;
  const targetLeaves = await findCandidateLeaves(layerUrl, mapPoint, targetRadiusSource, nodeCache);
  const targetCandidates = await loadFeatures(layerUrl, targetLeaves, geometryCache);
  const rankedTargets = targetCandidates
    .map((entry) => ({
      entry,
      distanceMetres: featurePointDistance(entry.feature, mapPoint) * horizontalScale,
    }))
    .filter((candidate) => candidate.distanceMetres <= options.targetSearchDistance + 1e-6)
    .sort((left, right) =>
      left.distanceMetres - right.distanceMetres ||
      left.entry.feature.featureId.localeCompare(right.entry.feature.featureId),
    );
  if (rankedTargets.length === 0) {
    throw new Error(
      `No building found within ${options.targetSearchDistance} m of ${location.latitude},${location.longitude}`,
    );
  }
  const target = rankedTargets[0];
  const targetBounds = bounds(target.entry.feature.vertices);
  const searchCenter = [
    (targetBounds.minimum[0] + targetBounds.maximum[0]) / 2,
    (targetBounds.minimum[1] + targetBounds.maximum[1]) / 2,
  ];
  const targetRadius = Math.max(
    ...target.entry.feature.vertices.map(({ position }) =>
      Math.hypot(position[0] - searchCenter[0], position[1] - searchCenter[1]),
    ),
  );
  const neighborSearchRadius = targetRadius + options.neighborDistance / horizontalScale;
  const neighborLeaves = await findCandidateLeaves(
    layerUrl,
    searchCenter,
    neighborSearchRadius,
    nodeCache,
  );
  const neighborCandidates = await loadFeatures(layerUrl, neighborLeaves, geometryCache);
  const selected = [{
    role: "primary",
    distanceMetres: 0,
    maximumDistanceFromPrimaryMetres: 0,
    entry: target.entry,
  }];
  for (const entry of neighborCandidates) {
    if (entry.feature.featureId === target.entry.feature.featureId) continue;
    const maximumDistanceFromPrimaryMetres =
      featureMaximumVertexDistanceFromFeature(target.entry.feature, entry.feature) * horizontalScale;
    if (maximumDistanceFromPrimaryMetres > options.neighborDistance + 1e-6) continue;
    const distanceMetres = featureDistance(target.entry.feature, entry.feature) * horizontalScale;
    selected.push({
      role: "neighbor",
      distanceMetres,
      maximumDistanceFromPrimaryMetres,
      entry,
    });
  }
  selected.sort((left, right) =>
    (left.role === "primary" ? -1 : right.role === "primary" ? 1 : 0) ||
    left.distanceMetres - right.distanceMetres ||
    left.entry.feature.featureId.localeCompare(right.entry.feature.featureId),
  );

  await Promise.all(
    selected.map(async (building) => {
      building.attributes = await extractAttributes(
        layerUrl,
        String(building.entry.node.id),
        building.entry.feature.row,
        layer,
        attributeCache,
      );
      if (String(building.attributes.OBJECTID) !== building.entry.feature.featureId) {
        throw new Error(
          `Geometry feature ID ${building.entry.feature.featureId} != OBJECTID ${building.attributes.OBJECTID}`,
        );
      }
    }),
  );

  const groundHeight = Number.parseFloat(selected[0].attributes.HoeheGrund);
  const slug = slugify(geocode?.matchedAddress ?? address);
  const outputDirectory = path.resolve(
    options.output ?? path.join(process.cwd(), ".work", slug),
  );
  const prefix = slug;
  await mkdir(outputDirectory, { recursive: true });

  const sourceMesh = {
    format: "ArcGIS I3S 1.8 decoded triangle meshes",
    crs: {
      horizontal: "EPSG:3857",
      vertical: "Source LoD2 elevation in metres",
    },
    addressedFeatureId: target.entry.feature.featureId,
    neighborDistanceMetres: options.neighborDistance,
    buildings: selected.map(buildingGeometryRecord),
  };
  const metadata = {
    request: {
      address,
      coordinatesOverride: options.coordinates,
      neighborDistanceMetres: options.neighborDistance,
      targetSearchDistanceMetres: options.targetSearchDistance,
    },
    geocode,
    selection: {
      locationWgs84: location,
      locationWebMercator: mapPoint,
      mode: target.distanceMetres <= 1e-6 ? "point_intersects_building" : "nearest_building",
      addressPointDistanceToPrimaryMetres: target.distanceMetres,
      neighborSelectionMode: "complete_geometry_within_primary_distance",
      buildingCount: selected.length,
      neighborCount: selected.length - 1,
    },
    source: {
      itemId: options.itemId,
      itemTitle: item.title,
      itemOwner: item.owner,
      itemModifiedEpochMs: item.modified,
      sceneServiceUrl: sceneUrl,
      layerName: layer.name,
      layerVersion: layer.version,
      serviceLastUpdateEpochMs: service.layers?.[0]?.serviceUpdateTimeStamp?.lastUpdate ?? null,
      attribution: "Bayerische Vermessungsverwaltung – www.geodaten.bayern.de",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
    objTransformation: {
      coordinateAxes: "X=east, Y=north, Z=up",
      originEpsg3857: mapPoint,
      verticalOriginMetres: groundHeight,
      horizontalScaleFromWebMercatorToLocalMetres: horizontalScale,
    },
    buildings: selected.map(buildingMetadataRecord),
  };
  const table = selected
    .map(
      (building) =>
        `| ${building.role} | ${building.attributes.OBJECTID} | ${building.attributes.gml_id || ""} | ${building.distanceMetres.toFixed(3)} | ${building.maximumDistanceFromPrimaryMetres.toFixed(3)} | ${building.entry.feature.vertices.length / 3} |`,
    )
    .join("\n");
  const readme = `# ${geocode?.matchedAddress ?? address} — LoD2 building export

The export contains the addressed building and neighbors no farther than
${options.neighborDistance} metres away. Every selected neighbor's complete horizontal geometry
stays within that distance of the primary building.

| Role | OBJECTID | GML ID | Closest distance from primary (m) | Farthest distance from primary (m) | Triangles |
| --- | ---: | --- | ---: | ---: | ---: |
${table}

## Files

- \`${prefix}.obj\`: combined local-metre OBJ with one named object per building.
- \`${prefix}.source-mesh.json\`: source-exact decoded I3S geometry.
- \`${prefix}.metadata.json\`: request, geocode, selection, attributes, distances, and attribution.

## Reproduce

\`\`\`sh
node extract_buildings.mjs --address ${JSON.stringify(address)} --neighbor-distance ${options.neighborDistance} --output ${JSON.stringify(outputDirectory)}
\`\`\`

License: CC BY 4.0. Attribution: **Bayerische Vermessungsverwaltung – www.geodaten.bayern.de**.
`;

  await Promise.all([
    writeFile(
      path.join(outputDirectory, `${prefix}.obj`),
      createObj(selected, mapPoint, horizontalScale, groundHeight, address, options.neighborDistance),
    ),
    writeFile(
      path.join(outputDirectory, `${prefix}.source-mesh.json`),
      `${JSON.stringify(sourceMesh, null, 2)}\n`,
    ),
    writeFile(
      path.join(outputDirectory, `${prefix}.metadata.json`),
      `${JSON.stringify(metadata, null, 2)}\n`,
    ),
    writeFile(path.join(outputDirectory, "README.md"), readme),
  ]);

  console.log(`Address: ${geocode?.matchedAddress ?? address}`);
  console.log(
    `Primary: ${selected[0].attributes.gml_id} (OBJECTID ${selected[0].attributes.OBJECTID})`,
  );
  console.log(`Neighbors fully within ${options.neighborDistance} m of primary: ${selected.length - 1}`);
  for (const building of selected.slice(1)) {
    console.log(
      `  ${building.distanceMetres.toFixed(3)} m  ${building.attributes.gml_id} (OBJECTID ${building.attributes.OBJECTID})`,
    );
  }
  console.log(`Output: ${outputDirectory}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
