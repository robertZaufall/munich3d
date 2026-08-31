# AGENTS.md

## Scope

These instructions apply to the entire `munich3d` repository.

## Project purpose

This project extracts source-matched LoD2 building geometry from the Munich
ArcGIS I3S scene, includes neighbors according to a recorded, configurable
distance rule, generates GLBs directly from the decoded source meshes, and
presents selected addresses in a local Three.js website. New extractions use
the farthest decoded neighbor vertex as their cutoff test.

The website discovers every complete bundle in `website/public/model/` and
generates one `website/lib/model-catalog/<model>.json` fragment per bundle.
The app discovers the locally available fragments at build time; do not
maintain a separate model list.

On-demand models use the same root pipeline code in both runtimes. The local
`website/server.mjs` launches the CLI entry points and caches below the
Git-ignored `website/.runtime/models/` directory. The Cloudflare build imports
the browser-safe in-memory extraction and GLB functions in a Web Worker and caches generated
artifacts in that browser's IndexedDB. The root files are runtime source and
must not be removed as cleanup. Runtime bundles retain only the GLB,
source-mesh JSON and metadata JSON; discard the extractor's reproducible OBJ
and README. Runtime models may be deleted through the API or browser UI, but
permanent bundles in `website/public/model/` must never be exposed through that
delete path.

Only the Rathaus bundle and catalog fragment are intended for Git. The root
`.gitignore` allowlists them; other address-bearing fragments are ignored with
their dedicated model bundles so a shared catalog cannot disclose private
model names or metadata.

Dedicated model files keep their original source names and metadata. Do not
rename or rewrite them for documentation anonymization.

## Canonical pipeline

1. Run `extract_buildings.mjs` with an address and neighbor distance in a
   temporary or `.work/` directory.
2. Generate the GLB directly from the source-mesh and metadata JSON with
   `export_model_to_glb.mjs`.
3. Keep only the GLB, metadata JSON, and source-mesh JSON as the permanent
   bundle in `website/public/model/`. Give all three files the same stable stem;
   the OBJ and per-extraction README are reproducible intermediates.
4. Run `npm run models:catalog` in `website/`, or let `npm run dev` / `npm run
   build` run it automatically.
5. Verify there is one generated catalog fragment per complete model bundle.
6. Build the website and verify the selector changes the model, facts, IDs,
   counts, source URL, and downloads together.

## Important correctness rules

- Never invent, smooth, reshape, or replace source geometry. In particular,
  preserve the source roof form exactly.
- The default neighbor cutoff is 35 metres from the addressed building. For a
  new extraction, include a neighbor only when its farthest decoded horizontal
  vertex is within that distance of the primary geometry; the addressed
  building itself is always retained.
- Existing legacy bundles may record `closest_geometry_from_primary` and lack
  maximum-distance fields. Preserve and describe their recorded rule until the
  bundle is deliberately regenerated; never present them as strict-distance
  bundles.
- Keep the addressed building distinct from neighbors. GLBs must contain one
  node per feature with `role`, `gml_id`, `OBJECTID`, and
  `distance_from_primary_m` extras. New strict-distance bundles also include
  `maximum_distance_from_primary_m`.
- Populate dimensions, elevations, storeys, IDs, feature counts, and distances
  from generated metadata. Do not estimate them visually.
- Keep the website chooser metadata-driven. Do not add hard-coded address
  records to `website/src/App.tsx`.
- Every stem in `website/public/model/` must have a GLB, metadata JSON and
  source-mesh JSON. Catalog generation must fail for incomplete bundles.
- Preserve the decoded source-mesh JSON and extraction metadata alongside each
  permanent GLB.
- Preserve CC BY 4.0 attribution to **Bayerische Vermessungsverwaltung –
  www.geodaten.bayern.de** in generated data and the website.
- Preserve the website copyright notice for **Robert Zaufall** separately from
  the source-data attribution.

## Website scope

- The supported development URL is `http://localhost:3000/`.
- Keep the generation server bound to loopback. Never accept a client-supplied
  output path.
- Validate address, coordinate, distance and request-size limits before running
  extraction. Use argument arrays without a shell when spawning scripts.
- Keep runtime-generated address bundles under `website/.runtime/`; do not copy
  them into tracked model or catalog paths automatically.
- The Cloudflare build at `/munich3d/` must use the subpath asset base, set
  `workers_dev: false`, and route only `/munich3d` plus `/munich3d/*`.
- Keep the hosted pipeline in the browser: no Blender, server compute, child
  process, container, OBJ output or temporary export directory. Persist the
  generated GLB, source-mesh JSON, metadata JSON and catalog data only in
  IndexedDB.
- Never create a public generated-address catalog. Browser-generated models
  remain local to that browser and must not be uploaded by the static build.
- Keep the browser and local API validation consistent for address and neighbor
  distance. The local API additionally retains its 16 KiB body limit.
- Do not deploy or publish the website unless explicitly requested.

## Commands

Extract an address:

```sh
node extract_buildings.mjs \
  --address "Münchner Rathaus, Marienplatz 8, 80331 München, Germany" \
  --neighbor-distance 35 \
  --output .work/muenchner-rathaus-35m
```

Generate a GLB:

```sh
node export_model_to_glb.mjs \
  INPUT.source-mesh.json \
  INPUT.metadata.json \
  OUTPUT.glb
```

Run and build the website:

```sh
cd website
npm install
npm run dev
npm run build
npm run build:cloudflare
```

## Validation

- Run `node --check extract_buildings.mjs` and
  `node --check export_model_to_glb.mjs` after pipeline changes.
- Test a second address as well as the checked-in sample after
  spatial-selection or distance changes.
- For bundles using `complete_geometry_within_primary_distance`, confirm every
  selected neighbor has `maximumDistanceFromPrimaryMetres <=
  neighborDistanceMetres`. Do not apply that assertion to legacy bundles that
  record `closest_geometry_from_primary`.
- Confirm metadata building count, source-mesh building count, and GLB role
  count agree.
- Run `npm run build` after website changes.
- Verify `/api/health`, cached and uncached `/api/models` responses, and runtime
  GLB downloads after generation-server changes.
- Verify the Cloudflare build's browser generation, IndexedDB reload and
  deletion paths on the deployed site.
- Verify deleting a runtime model removes its cache directory and chooser entry,
  selects a valid fallback, and cannot delete a permanent model bundle.
- For selector changes, verify all addresses in a real browser and require a
  clean console.
- Verify model loading automatically fits the visible geometry. Turning off the
  neighbor-house switch must hide every neighbor node, retain the primary node,
  refit the camera to the primary building, and resize/recenter the ground plate
  and grid to that visible footprint.
- Verify depth-map mode renders visible geometry in camera-relative grayscale,
  hides the decorative ground and grid, and restores the regular materials when
  disabled.
- Verify the compass's north pointer and heading update with camera orbit and
  retain the source coordinate convention after model changes.

## Repository hygiene

- Keep `node_modules`, `dist`, browser-test output, and other reproducible
  caches out of version control. `node_modules` may exist locally after
  installation while the website is being run.
- Keep private address bundles and their generated catalog fragments ignored.
