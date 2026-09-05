import { findAddressBundle } from './address-bundles.mjs';
// Fetch a bounded OSM supplement; pass its output as a third surface-builder input.
import fs from "node:fs/promises";
import path from "node:path";
const [stem, output] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9-]*$/.test(stem ?? "") || !output)
  throw Error(
    "Usage: node scripts/fetch-area-transport.mjs <model-stem> <output.json>",
  );
const bundle = await findAddressBundle(stem);
const m = JSON.parse(
  await fs.readFile(
    path.join(bundle.modelDirectory, `${stem}.metadata.json`),
    "utf8",
  ),
);
const t = m.objTransformation,
  scale = t.horizontalScaleFromWebMercatorToLocalMetres;
const bounds = m.buildings.reduce(
  (b, v) => [
    Math.min(b[0], v.boundsEpsg3857.minimum[0]),
    Math.min(b[1], v.boundsEpsg3857.minimum[1]),
    Math.max(b[2], v.boundsEpsg3857.maximum[0]),
    Math.max(b[3], v.boundsEpsg3857.maximum[1]),
  ],
  [Infinity, Infinity, -Infinity, -Infinity],
);
const lon = (x) => ((x / 6378137) * 180) / Math.PI,
  lat = (y) =>
    ((2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180) / Math.PI;
const box = [
  lat(bounds[1] - 12 / scale),
  lon(bounds[0] - 12 / scale),
  lat(bounds[3] + 12 / scale),
  lon(bounds[2] + 12 / scale),
]
  .map((n) => n.toFixed(6))
  .join(",");
const query = `[out:json][timeout:45];(way[railway](${box});way[highway](${box});node[highway](${box});node[entrance](${box});node[amenity~"^(bench|waste_basket)$"](${box}););out geom;`;
const response = await fetch(
  (process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter") +
    "?" +
    "data=" +
    encodeURIComponent(query),
  {
    headers: { "User-Agent": "munich3d-local/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  },
);
if (!response.ok)
  throw Error(`Overpass ${response.status}: ${await response.text()}`);
const data = await response.json();
if (data.remark || !Array.isArray(data.elements))
  throw Error(data.remark ?? "Malformed OSM response");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(data));
console.log(
  JSON.stringify({
    stem,
    elements: data.elements.length,
    railways: data.elements
      .filter((e) => e.tags?.railway)
      .map((e) => ({ id: e.id, tags: e.tags })),
  }),
);
