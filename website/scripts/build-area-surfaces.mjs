import path from 'node:path';
import { findAddressBundle } from './address-bundles.mjs';
// Usage: node scripts/build-area-surfaces.mjs <model-stem> <ways.json> <relations.json>
// Raw bounded OSM snapshots are inputs; no address catalog or runtime data is read.
// Overpass provides osm3s.timestamp_osm_base; converted map API responses use retrievedAt.
import fs from "node:fs/promises";
const modelId = process.argv[2];
if (!/^[a-z0-9][a-z0-9-]*$/.test(modelId ?? ""))
  throw Error("Invalid model stem");
const inputs = await Promise.all(
  process.argv
    .slice(3)
    .map(async (p) => JSON.parse(await fs.readFile(p, "utf8"))),
);
if (inputs.length < 2 || inputs.some((d) => !Array.isArray(d.elements)))
  throw Error("Supply at least both Overpass JSON snapshots");
const snapshotTime = inputs[0].osm3s?.timestamp_osm_base ?? inputs[0].retrievedAt;
if (typeof snapshotTime !== "string" || !Number.isFinite(Date.parse(snapshotTime)))
  throw Error("OSM snapshot must record its source timestamp or retrieval time");
const bundle = await findAddressBundle(modelId);
const metadata = JSON.parse(
  await fs.readFile(path.join(bundle.modelDirectory, `${modelId}.metadata.json`), "utf8"),
);
const transform = metadata.objTransformation;
const scale = transform.horizontalScaleFromWebMercatorToLocalMetres;
const project = ({ lon, lat }) =>
  [
    ((6378137 * lon * Math.PI) / 180 - transform.originEpsg3857[0]) * scale,
    -(
      6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) -
      transform.originEpsg3857[1]
    ) * scale,
  ].map((n) => Math.round(n * 1000) / 1000);
const bounds = [Infinity, Infinity, -Infinity, -Infinity];
const anchors = metadata.buildings.map((b) => {
  const [a, c] = [b.boundsEpsg3857.minimum, b.boundsEpsg3857.maximum];
  const minX = (a[0] - transform.originEpsg3857[0]) * scale,
    maxX = (c[0] - transform.originEpsg3857[0]) * scale;
  const minZ = -(c[1] - transform.originEpsg3857[1]) * scale,
    maxZ = -(a[1] - transform.originEpsg3857[1]) * scale;
  bounds[0] = Math.min(bounds[0], minX);
  bounds[1] = Math.min(bounds[1], minZ);
  bounds[2] = Math.max(bounds[2], maxX);
  bounds[3] = Math.max(bounds[3], maxZ);
  return {
    bounds: [minX, minZ, maxX, maxZ],
    height: Number(b.attributes.HoeheGrund) - transform.verticalOriginMetres,
  };
});
for (let i = 0; i < 4; i++) bounds[i] += i < 2 ? -8 : 8;
const inside = (p) =>
  p[0] >= bounds[0] &&
  p[0] <= bounds[2] &&
  p[1] >= bounds[1] &&
  p[1] <= bounds[3];
function clip(ring) {
  let output = ring;
  for (const [axis, limit, sign] of [
    [0, bounds[0], 1],
    [0, bounds[2], -1],
    [1, bounds[1], 1],
    [1, bounds[3], -1],
  ]) {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i],
        b = input[(i + 1) % input.length];
      const ain = (a[axis] - limit) * sign >= 0,
        bin = (b[axis] - limit) * sign >= 0;
      if (ain) output.push(a);
      if (ain !== bin) {
        const t = (limit - a[axis]) / (b[axis] - a[axis]);
        output.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return output;
}
const elements = [
  ...new Map(
    inputs.flatMap((d) => d.elements).map((e) => [`${e.type}/${e.id}`, e]),
  ).values(),
];
const equal = (a, b) => a.lat === b.lat && a.lon === b.lon;
function stitch(members) {
  const parts = members
    .filter((m) => m.geometry?.length)
    .map((m) => [...m.geometry]);
  const rings = [];
  while (parts.length) {
    const ring = parts.shift();
    while (!equal(ring[0], ring.at(-1))) {
      const i = parts.findIndex(
        (p) => equal(p[0], ring.at(-1)) || equal(p.at(-1), ring.at(-1)),
      );
      if (i < 0) throw Error("Unclosed OSM surface relation");
      const next = parts.splice(i, 1)[0];
      if (!equal(next[0], ring.at(-1))) next.reverse();
      ring.push(...next.slice(1));
    }
    rings.push(ring.slice(0, -1).map(project));
  }
  return rings;
}
const surfaces = [],
  lines = [],
  points = [];
const memberIds = new Set(
  elements
    .filter((e) => e.type === "relation" && e.tags?.type === "multipolygon")
    .flatMap((e) => e.members.map((m) => m.ref)),
);
for (const e of elements) {
  const t = e.tags ?? {};
  if (
    t.tunnel ||
    Number(t.layer ?? 0) < 0 ||
    Number(t.level ?? 0) < 0 ||
    t.indoor === "yes"
  )
    continue;
  const base = {
    osmId: `${e.type}/${e.id}`,
    name: t.name ?? "",
    surface: t.surface ?? (t.railway === "platform" ? "paving_stones" : ""),
    tags: t,
  };
  if (e.type === "node") {
    const p = project(e);
    if (
      inside(p) &&
      (t.natural === "tree" ||
        t.entrance ||
        t.name === "Mariensäule" ||
        ["bench", "waste_basket"].includes(t.amenity) ||
        ["crossing", "street_lamp", "traffic_signals"].includes(t.highway))
    )
      points.push({ ...base, point: p });
    continue;
  }
  const isArea =
    t.area === "yes" ||
    t.railway === "platform" ||
    t["area:highway"] ||
    t.natural === "water" ||
    t.landuse === "grass" ||
    t.landuse === "meadow" ||
    t.natural === "wood" ||
    t.leisure === "park" ||
    t.landuse === "construction" ||
    (e.type === "relation" && t.type === "multipolygon" && t.highway);
  if (isArea) {
    let outers = [],
      holes = [];
    if (e.type === "relation") {
      outers = stitch(e.members.filter((m) => m.role === "outer"));
      holes = stitch(e.members.filter((m) => m.role === "inner"));
    } else if (e.geometry?.length && equal(e.geometry[0], e.geometry.at(-1)))
      outers = [e.geometry.slice(0, -1).map(project)];
    for (const outer of outers) {
      const ring = clip(outer);
      if (ring.length < 3) continue;
      surfaces.push({
        ...base,
        ring,
        holes: holes.map(clip).filter((h) => h.length >= 3),
      });
    }
  } else if (
    e.geometry?.length &&
    (t.highway ||
      ["tram", "rail", "light_rail", "narrow_gauge"].includes(t.railway)) &&
    !memberIds.has(e.id)
  ) {
    const allowed = [
      "residential",
      "primary",
      "secondary",
      "tertiary",
      "cycleway",
      "service",
      "unclassified",
      "living_street",
      "pedestrian",
      "footway",
      "path",
      "steps",
    ];
    const rail = ["tram", "rail", "light_rail", "narrow_gauge"].includes(
      t.railway,
    );
    if (!rail && !allowed.includes(t.highway)) continue;
    const projected = e.geometry.map(project);
    // Clip long ways even when both of their endpoints are outside the area.
    const pieces = [];
    for (let i = 1; i < projected.length; i++) {
      const a = projected[i - 1],
        b = projected[i],
        delta = [b[0] - a[0], b[1] - a[1]];
      let lo = 0,
        hi = 1;
      for (const [axis, min, max] of [
        [0, bounds[0], bounds[2]],
        [1, bounds[1], bounds[3]],
      ]) {
        if (Math.abs(delta[axis]) < 1e-9) {
          if (a[axis] < min || a[axis] > max) hi = -1;
        } else {
          const t1 = (min - a[axis]) / delta[axis],
            t2 = (max - a[axis]) / delta[axis];
          lo = Math.max(lo, Math.min(t1, t2));
          hi = Math.min(hi, Math.max(t1, t2));
        }
      }
      if (hi <= lo) continue;
      const start = [a[0] + delta[0] * lo, a[1] + delta[1] * lo],
        end = [a[0] + delta[0] * hi, a[1] + delta[1] * hi];
      const previous = pieces.at(-1);
      if (
        previous &&
        Math.hypot(
          previous.at(-1)[0] - start[0],
          previous.at(-1)[1] - start[1],
        ) < 0.001
      )
        previous.push(end);
      else pieces.push([start, end]);
    }
    for (const points of pieces)
      lines.push({
        ...base,
        points,
        surface:
          t.surface ||
          (rail
            ? "ballast"
            : ["footway", "pedestrian", "steps", "path"].includes(t.highway)
              ? "paving_stones"
              : "asphalt"),
        width:
          (rail ? 2.8 : Number.parseFloat(t.width)) ||
          (["pedestrian", "living_street"].includes(t.highway)
            ? 5
            : ["footway", "path", "steps"].includes(t.highway)
              ? 1.8
              : t.highway === "cycleway"
                ? 2.2
                : t.highway === "service"
                  ? 3.2
                  : Number(t.lanes) > 0
                    ? Number(t.lanes) * 3.15
                    : 6),
        widthEstimated: !t.width,
      });
  }
}
const data = {
  schemaVersion: 1,
  modelId,
  architectureStyle:
    metadata.buildings.find((b) => b.role === "primary")?.attributes?.gml_id ===
    "DEBY_LOD2_4957695"
      ? "gothic"
      : "generic",
  source: "OpenStreetMap contributors",
  license: "ODbL 1.0",
  sourceUrl: "https://www.openstreetmap.org/copyright",
  snapshot: snapshotTime,
  coordinateAxes: "X=east, Y=up, Z=south (same origin as building GLB)",
  bounds,
  anchors,
  surfaces,
  lines,
  points,
  notes: [
    "Mapped surface boundaries and point locations are sourced from OSM.",
    "Ground elevations are interpolated from LoD2 building ground heights; this is not a surveyed terrain model.",
    "Unmapped road widths, paving modules, materials, vegetation and monument forms are illustrative reconstructions.",
    "Surface rail alignments and railway gauges are mapped; sleeper spacing, ballast, inferred sidewalks, kerbs and street furniture shapes are illustrative. Underground and removed railways are excluded.",
  ],
};
// Reference profiles are hand-reviewed, local-only additions; regeneration of
// OSM surfaces must not silently erase them. Never carry one to a different ID.
const outputPath = path.join(bundle.directory, "area", `${modelId === "muenchner-rathaus-100m" ? "rathaus-surfaces" : modelId}.json`);
try {
  const previous = JSON.parse(await fs.readFile(outputPath, "utf8"));
  const primaryId = metadata.buildings.find((b) => b.role === "primary")
    ?.attributes?.gml_id;
  if (previous.primaryFacade?.gmlId === primaryId)
    data.primaryFacade = previous.primaryFacade;
  if (previous.primaryFacade?.gmlId === primaryId) {
    const ids = new Set(metadata.buildings.map((b) => b.attributes?.gml_id));
    for (const key of ["connectedFacades", "neighborFacades"])
      if (previous[key]) data[key] = previous[key].filter((p) => ids.has(p.gmlId));
    if (previous.photoReferenceNotes) data.photoReferenceNotes = previous.photoReferenceNotes;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await fs.mkdir(path.join(bundle.directory, "area"), { recursive: true });
await fs.writeFile(
  path.join(bundle.directory, "area", `${modelId === "muenchner-rathaus-100m" ? "rathaus-surfaces" : modelId}.json`),
  JSON.stringify(data),
);
console.log(
  JSON.stringify({
    surfaces: surfaces.length,
    lines: lines.length,
    points: points.length,
    bounds,
  }),
);
