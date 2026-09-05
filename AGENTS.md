# Agent instructions

These rules apply to the entire repository. See [README.md](README.md) for
setup, extraction commands, asset layout and runtime architecture.

## Source correctness

- Preserve decoded source vertices, triangle topology and roof forms. Never
  invent, smooth, reshape or replace source geometry. Illustrative reconstruction
  belongs in separate geometry; LoD2 comparison and downloads retain the source.
- Always retain the addressed building. New extractions use
  `complete_geometry_within_primary_distance`: every decoded horizontal vertex
  of a neighbor must be within the requested distance of primary geometry.
  The extraction default is 35 m; the shipped Rathaus sample is 100 m.
- Preserve legacy `closest_geometry_from_primary` bundles and their recorded
  rule until deliberately regenerated. Do not label them strict-distance bundles
  or require maximum-distance fields they do not contain.
- Export one GLB node per source feature, preserving `role`, `gml_id`,
  `OBJECTID` and `distance_from_primary_m` extras. New strict bundles also carry
  `maximum_distance_from_primary_m`. Keep primary and neighbor source roles distinct.
- Derive dimensions, elevations, storeys, IDs, counts and distances from metadata.
  Missing values remain unavailable; do not estimate them visually.
- The statewide BayernAtlas fallback is shared by Node and the browser. Preserve
  tile refinement, source topology, GML IDs and legacy glTF node/Y-up/RTC
  transforms. Label its WGS84 ellipsoidal heights; do not invent OBJECTID or storeys.
- Preserve **Bayerische Vermessungsverwaltung – www.geodaten.bayern.de**
  attribution under CC BY 4.0, OSM attribution under ODbL separately, and the
  separate **Robert Zaufall** website copyright notice.

## Bundles, privacy and cleanup

- Keep permanent assets together under `website/addresses/<address>/`:
  `model/` for bundles, `area/` for snapshots/profiles, `catalog/` for generated
  chooser metadata. Multiple distance variants share an address folder.
- Every model stem must have `.glb`, `.metadata.json` and `.source-mesh.json`.
  Preserve original bundle names and metadata; do not anonymize them in place.
  Catalog generation must fail for incomplete bundles or duplicate model IDs.
- Extract into `.work/` or a temporary directory, export GLB directly from the
  source-mesh and metadata JSON, then retain only those three permanent files.
  OBJ and extraction README files are reproducible intermediates.
- Discover models and associated area snapshots from per-address catalogs and
  matching `modelId` values. Never maintain a parallel model list or hard-code
  private address records in `website/src/App.tsx`.
- Only the Rathaus 100 m sample is intended for Git. Keep other address folders,
  including their catalogs and reference profiles, ignored. Do not restore 35 m.
- Git ignore rules do not filter build assets: builds include locally present
  permanent models and snapshots. Check asset scope before any authorized
  publication; never publish private addresses implicitly.
- Preserve private folders, photo references, `.work/` investigations, runtime
  models and local state during cleanup. Remove only identified reproducible
  output. Keep dependencies needed by a running server.
- The root `extract_buildings.mjs`, `import_bayernatlas.mjs` and
  `export_model_to_glb.mjs` are runtime source, not cleanup candidates.
- Keep dependencies, builds, browser-test output and caches out of Git. Preserve
  unrelated worktree edits. Pushes to `master` trigger the authorized GitHub Actions
  production deployment. Do not publish through other paths unless requested.
- Preserve the public deployment guard and live-file verification in
  `.github/workflows/deploy.yml`; never bypass them to include private assets.

## Explorer and reconstruction

- Maintain one unified explorer. Default to Rathaus 100 m and original LoD2.
- Keep compact, direct controls in one bottom row: rotation icon and Reset view; Building /
  Neighbourhood; LoD2 / Depth / Facade; independent Solid / Wireframe. Rotation
  starts enabled. Reset view preserves display mode and playback. Show only
  applicable controls. No dropdowns, Entrance or Streets buttons.
- Keep details open by default and available area-width choices in the right
  column. Retain the dark scene and avoid default document scrollbars.
- Loading a model fits visible geometry. Building / Neighbourhood refits the
  camera and ground/grid. Selecting Facade preserves the current camera.
- Building mode retains the primary and explicitly grouped `connectedFacades`
  parts of the same complex without rewriting source roles. Independent
  neighbors, including `neighborFacades`, hide in Building mode.
- Wireframe works with both source and reconstruction. Depth uses camera-relative
  grayscale and hides decorative ground/grid; leaving it restores normal materials.
  Preserve X=east, Y=up, Z=south and the orbit-linked compass.
- Match photo profiles to exact source GML IDs. Preserve reference notes and
  confidence limits; do not describe procedural detail as surveyed. Reserve
  Gothic detailing for Rathaus; use generic or reference-based profiles elsewhere.
- Use bounded OSM snapshots for mapped surface boundaries and locations. Document
  inferred widths, ground interpolation and unrecorded detail as approximations.
  Preserve valid facade profiles when regenerating snapshots.

## Runtime boundaries

- Use the same root extraction/export pipeline in both runtimes. Local
  `website/server.mjs` launches CLI entry points and binds to loopback only;
  the supported development URL is `http://localhost:3000/`.
- Validate addresses, coordinates, distance and request size before extraction.
  Keep browser/local address and distance validation consistent, including the
  local API's 16 KiB body limit. Spawn argument arrays without a shell; never
  accept a client-supplied output path.
- Local generated bundles stay under `website/.runtime/models/`. Retain GLB,
  source-mesh and metadata, discarding reproducible OBJ/README output. Never
  promote runtime bundles to permanent assets automatically.
- Deletion must affect only runtime models, remove their cache/chooser entry and
  choose a valid fallback. Permanent address bundles must not enter that path.
- Hosted generation runs in a browser Web Worker with IndexedDB persistence for
  GLB, source-mesh, metadata and catalog data. No server compute, Blender, child
  processes, containers, OBJ output or temporary export directories.
- Keep the icon-only Import ZIP button immediately beside Add address in one
  non-wrapping group. Retain its accessible label and tooltip. Import status
  belongs in the header; importing adds/selects an address in the site-wide
  chooser, independent of the selected address. Keep Export ZIP and its status
  in the selected address column.
- ZIP sharing includes the original bundle and the complete optional area snapshot,
  including primary, connected and neighbor façade profiles. Imports stay in
  IndexedDB on both localhost and the hosted site; never write them to permanent
  folders or upload them. Validate archives before atomic persistence. Preserve
  the versioned format and checksums, and include address, area size and local
  timestamp in ZIP filenames. Reference notes are included; external photos are
  not bundled. Imported-model deletion must retain permanent source bundles.
- Never upload browser-generated addresses or create a public generated catalog.
- Cloudflare assets use `/munich3d/`; retain `workers_dev: false` and routes only
  for `/munich3d` and `/munich3d/*`.

## Documentation and screenshots

- Keep README controls, ZIP sharing instructions and screenshots aligned with the
  current interface. Use only the public Rathaus 100 m sample in documentation.
- Capture from a fresh isolated browser session on the public site or a preview
  containing only public assets. Check the chooser and import cache; private
  names can appear even when they are Git-ignored. Never clear user browser
  storage or remove private folders to prepare screenshots.
- Use 1600 × 1000, wait for model readiness, pause rotation and reset the selected
  scope. Let transitions settle so button states match the rendered scene.
  Review every image before publication, including dialogs and import status.
- Refresh the homepage, neighbourhood facade, building facade, reconstruction
  wireframe, source depth, Add address form and public ZIP import example under
  `docs/`. Keep temporary screenshots and ZIPs in ignored
  `website/output/playwright/`; never commit private archives.

## Validation by change

Run relevant checks below; documentation-only changes need link/command review
and `git diff --check`, not extraction or builds.

| Change | Required checks |
| --- | --- |
| Pipeline | `node --check` on changed root `.mjs` files; source-mesh, metadata and GLB counts/roles agree. |
| Selection or distance | Test Rathaus and a second address. For strict bundles, every neighbor has `maximumDistanceFromPrimaryMetres <= neighborDistanceMetres`; preserve legacy rules. |
| BayernAtlas decoder | `node --test tests/bayernatlas.test.mjs`. |
| Bundle/catalog discovery | `node --test website/scripts/address-bundles.test.mjs`; one catalog per complete bundle. |
| Website | `npm run build --prefix website`. |
| Reconstruction/camera | `node website/scripts/test-area-reconstruction.mjs` and `node website/scripts/test-area-camera.mjs`, passing the changed model ID when applicable; build and real-browser verification. |
| Selector/viewer | All available addresses in a real browser, clean console; model, metadata, source link and downloads change together. Verify fitting, connected-part visibility, Facade camera stability, depth, wireframe and compass. |
| Local generation server | Health, cached/uncached generation, runtime GLB download, deletion/fallback and permanent-model deletion protection. |
| ZIP sharing | `node --test website/scripts/address-archive.test.mjs`; import while a different address is selected, verify the global chooser entry, façade view, reload, byte-preserving re-export and deletion. Use only Rathaus in public documentation. |
| Browser generation | Cloudflare build; browser generation, IndexedDB reload and deletion. Repeat on the deployed site only after explicitly authorized deployment. |
