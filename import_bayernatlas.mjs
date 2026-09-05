// Browser-safe decoder for the public BayernAtlas LoD2 3D Tiles feed.
import { bounds, featurePointDistance, featureDistance, featureMaximumVertexDistanceFromFeature, buildingGeometryRecord, buildingMetadataRecord, createObj, slugify } from './extract_buildings.mjs';
export const TILESET = 'https://bvv3d21.bayernwolke.de/3d-data/latest/lod23d/tileset.json';
const R = 6378137, E2 = 6.6943799901413165e-3;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const decoder = new TextDecoder();
function apply(m, p) { return [0, 1, 2].map(i => m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12]); }
function multiply(a, b) { return Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((s, k) => s + a[i % 4 + k * 4] * b[k + Math.floor(i / 4) * 4], 0)); }
export function ecefToMercator([x, y, z]) {
    const lon = Math.atan2(y, x), p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - E2)), h = 0;
    for (let i = 0; i < 10; i++) {
        const n = R / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
        h = p / Math.cos(lat) - n;
        lat = Math.atan2(z, p * (1 - E2 * n / (n + h)));
    }
    return [R * lon, R * Math.log(Math.tan(Math.PI / 4 + lat / 2)), h];
}
export function decodeBayernatlasTile(bytes, tileUrl, tileTransform = identity) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u = i => v.getUint32(i, true);
    const json = (a, n) => JSON.parse(decoder.decode(bytes.subarray(a, a + n)).trim());
    if (decoder.decode(bytes.subarray(0, 4)) !== 'b3dm' || u(4) !== 1 || u(8) !== bytes.length)
        throw Error('Invalid BayernAtlas b3dm');
    // This feed uses the legacy 24-byte b3dm header (batch JSON, binary, count).
    const batch = json(24, u(12)), offset = 24 + u(12) + u(16), count = u(20);
    if (decoder.decode(bytes.subarray(offset, offset + 4)) !== 'glTF' || u(offset + 4) !== 1)
        throw Error('Unsupported BayernAtlas GLB version');
    const gltf = json(offset + 20, u(offset + 12)), binary = offset + 20 + u(offset + 12);
    if (u(offset + 16) !== 0 || offset + u(offset + 8) > bytes.length || bytes.length - offset - u(offset + 8) > 3)
        throw Error('Invalid GLB payload');
    const rtc = gltf.extensions?.CESIUM_RTC?.center;
    if (!rtc || batch.id?.length !== count)
        throw Error('Tile lacks feature identities or RTC origin');
    const entries = new Map();
    const read = (id, index) => {
        const a = gltf.accessors[id], b = gltf.bufferViews[a.bufferView];
        const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }, types = { 5121: [1, 'getUint8'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
        const type = types[a.componentType], n = sizes[a.type];
        if (!type || !n || index < 0 || index >= a.count || b.buffer !== 'binary_glTF')
            throw Error('Unsupported or invalid accessor');
        const start = binary + (b.byteOffset ?? 0) + (a.byteOffset ?? 0) + index * (a.byteStride || n * type[0]);
        if (start + n * type[0] > binary + (b.byteOffset ?? 0) + b.byteLength)
            throw Error('Accessor exceeds buffer');
        return Array.from({ length: n }, (_, j) => v[type[1]](start + j * type[0], true));
    };
    function walk(id, parent) {
        const node = gltf.nodes[id];
        if (!node.matrix && (node.translation || node.rotation || node.scale))
            throw Error('Unsupported node TRS');
        const matrix = multiply(parent, node.matrix ?? identity);
        for (const meshId of node.meshes ?? [])
            for (const p of gltf.meshes[meshId].primitives) {
                if (p.mode !== 4)
                    throw Error('Expected triangles');
                const a = p.attributes, n = p.indices ? gltf.accessors[p.indices].count : gltf.accessors[a.POSITION].count;
                if (n % 3)
                    throw Error('Incomplete triangle');
                const material = gltf.materials[p.material]?.values?.diffuse_mat ?? [1, 1, 1, 1];
                for (let i = 0; i < n; i += 3) {
                    const inds = [0, 1, 2].map(j => p.indices ? read(p.indices, i + j)[0] : i + j);
                    const ids = inds.map(j => read(a._BATCHID, j)[0]);
                    if (ids.some(b => b !== ids[0]) || !batch.id[ids[0]])
                        throw Error('Triangle crosses feature identities');
                    const row = ids[0], id = batch.id[row];
                    if (!entries.has(id))
                        entries.set(id, { featureId: id, row, vertices: [], sourceAttributes: batch.attributes?.[row] ?? {}, tileUrl });
                    const out = entries.get(id);
                    const positions = inds.map(j => {
                        const q = apply(matrix, read(a.POSITION, j));
                        // glTF Y-up -> 3D Tiles Z-up; RTC is already ECEF.
                        return ecefToMercator(apply(tileTransform, [q[0] + rtc[0], -q[2] + rtc[1], q[1] + rtc[2]]));
                    });
                    const ab = positions[1].map((x, j) => x - positions[0][j]), ac = positions[2].map((x, j) => x - positions[0][j]);
                    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
                    const len = Math.hypot(...normal) || 1;
                    for (const position of positions)
                        out.vertices.push({ position, normal: normal.map(x => x / len), color: material.slice(0, 3).map(x => Math.round(x * 255)), uv: [0, 0] });
                }
            }
        for (const child of node.children ?? [])
            walk(child, matrix);
    }
    for (const id of gltf.scenes[gltf.scene].nodes)
        walk(id, identity);
    const features = [...entries.values()];
    const vertexCount = features.reduce((sum, feature) => sum + feature.vertices.length, 0);
    return features.map(feature => ({ ...feature, sourceTileFeatureCount: count, sourceTileVertexCount: vertexCount, tileCenter: ecefToMercator(apply(tileTransform, rtc)) }));
}
async function request(url, binary = false) { const r = await fetch(url); if (!r.ok)
    throw Error(`BayernAtlas ${r.status}: ${url}`); return binary ? new Uint8Array(await r.arrayBuffer()) : r.json(); }
export async function extractBayernatlas(options, geocode, location) {
    const lon = location.longitude * Math.PI / 180, lat = location.latitude * Math.PI / 180, scale = Math.cos(lat);
    const origin = [R * lon, R * Math.log(Math.tan(Math.PI / 4 + lat / 2))];
    const tileCache = new Map(), jsonCache = new Map();
    let requests = 0;
    async function load(radius) {
        const features = new Map(), dlat = radius / R, dlon = dlat / scale;
        async function tiles(url, parent = identity, inheritedRefine = 'REPLACE') {
            if (!jsonCache.has(url)) {
                if (++requests > 200)
                    throw Error('Tile traversal limit exceeded');
                jsonCache.set(url, await request(url));
            }
            async function walk(n, transform, inheritedRefine) {
                const r = n.boundingVolume?.region;
                if (!r)
                    throw Error('Unsupported tileset bounding volume');
                if (r[0] > lon + dlon || r[2] < lon - dlon || r[1] > lat + dlat || r[3] < lat - dlat)
                    return;
                transform = multiply(transform, n.transform ?? identity);
                const refine = n.refine ?? inheritedRefine;
                if (n.children?.length) {
                    for (const child of n.children)
                        await walk(child, transform, refine);
                    if (refine !== 'ADD') return;
                }
                const content = n.content?.uri ?? n.content?.url;
                if (!content)
                    return;
                const next = new URL(content, url).href;
                if (next.endsWith('.json'))
                    return tiles(next, transform, refine);
                if (!tileCache.has(next)) {
                    if (++requests > 200)
                        throw Error('Tile traversal limit exceeded');
                    tileCache.set(next, decodeBayernatlasTile(await request(next, true), next, transform));
                }
                for (const f of tileCache.get(next)) {
                    if (features.has(f.featureId))
                        throw Error(`Duplicate feature across leaf tiles: ${f.featureId}`);
                    features.set(f.featureId, f);
                }
            }
            await walk(jsonCache.get(url).root, parent, inheritedRefine);
        }
        await tiles(TILESET);
        return [...features.values()];
    }
    const candidates = await load(options.targetSearchDistance + 5);
    const pointNearBounds = feature => {
        const box = bounds(feature.vertices);
        return Math.hypot(Math.max(box.minimum[0] - origin[0], 0, origin[0] - box.maximum[0]), Math.max(box.minimum[1] - origin[1], 0, origin[1] - box.maximum[1])) * scale <= options.targetSearchDistance;
    };
    const ranked = candidates.filter(pointNearBounds).map(feature => ({ feature, distance: featurePointDistance(feature, origin) * scale })).filter(x => x.distance <= options.targetSearchDistance).sort((a, b) => a.distance - b.distance || a.feature.featureId.localeCompare(b.feature.featureId));
    if (!ranked.length)
        throw Error('No BayernAtlas building found near this address');
    const target = ranked[0], radius = Math.max(...target.feature.vertices.map(v => Math.hypot(v.position[0] - origin[0], v.position[1] - origin[1]) * scale)) + options.neighborDistance + 5;
    const nearby = await load(radius), selected = [];
    const primaryBounds = bounds(target.feature.vertices);
    for (const feature of nearby) {
        const primary = feature.featureId === target.feature.featureId;
        const featureBounds = bounds(feature.vertices);
        // A vertex beyond the expanded primary AABB cannot meet the strict cutoff.
        // Reject remote features packed into ADD parent tiles before triangle tests.
        if (!primary && [0, 1].some(axis => featureBounds.minimum[axis] < primaryBounds.minimum[axis] - options.neighborDistance / scale || featureBounds.maximum[axis] > primaryBounds.maximum[axis] + options.neighborDistance / scale)) continue;
        const max = primary ? 0 : featureMaximumVertexDistanceFromFeature(target.feature, feature) * scale;
        if (max > options.neighborDistance + 1e-6)
            continue;
        const box = bounds(feature.vertices), ground = box.minimum[2], roof = box.maximum[2];
        selected.push({ role: primary ? 'primary' : 'neighbor', distanceMetres: primary ? 0 : featureDistance(target.feature, feature) * scale, maximumDistanceFromPrimaryMetres: max,
            attributes: { gml_id: feature.featureId, HoeheGrund: ground, HoeheDach: roof, citygml_measured_height: roof - ground, ...feature.sourceAttributes },
            entry: { feature, node: { id: feature.tileUrl, mbs: feature.tileCenter, level: null }, geometry: { featureCount: feature.sourceTileFeatureCount, vertexCount: feature.sourceTileVertexCount } } });
    }
    selected.sort((a, b) => (a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0) || a.distanceMetres - b.distanceMetres || a.entry.feature.featureId.localeCompare(b.entry.feature.featureId));
    if (selected[0]?.role !== 'primary')
        throw Error('Primary missing from neighbourhood tiles');
    const address = options.address ?? `${location.latitude},${location.longitude}`, prefix = slugify(geocode?.matchedAddress ?? address);
    const sourceMesh = { format: 'BayernAtlas 3D Tiles legacy b3dm / glTF 1 decoded triangle meshes', crs: { horizontal: 'EPSG:3857', vertical: 'WGS84 ellipsoidal height in metres, decoded from ECEF' }, addressedFeatureId: target.feature.featureId, neighborDistanceMetres: options.neighborDistance, buildings: selected.map(buildingGeometryRecord) };
    const metadata = { request: { address, coordinatesOverride: options.coordinates, neighborDistanceMetres: options.neighborDistance, targetSearchDistanceMetres: options.targetSearchDistance }, geocode,
        selection: { locationWgs84: location, locationWebMercator: origin, mode: target.distance < 1e-6 ? 'point_intersects_building' : 'nearest_building', addressPointDistanceToPrimaryMetres: target.distance, neighborSelectionMode: 'complete_geometry_within_primary_distance', buildingCount: selected.length, neighborCount: selected.length - 1 },
        source: { itemTitle: 'BayernAtlas 3D – LoD2 Bayern', sceneServiceUrl: TILESET, viewerUrl: `https://geodaten.bayern.de/bayernatlas_3d_preview/?c=${location.longitude},${location.latitude}&z=19&r=0&l=vt_luftbild&mid=50&res=0.5`, format: '3D Tiles / legacy b3dm / glTF 1', retrievedAt: new Date().toISOString(), tileUrls: [...tileCache.keys()], attribution: 'Bayerische Vermessungsverwaltung – www.geodaten.bayern.de', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', verticalDatum: 'WGS84 ellipsoid; not DHHN orthometric elevation', notes: 'Positions transformed from source ECEF to EPSG:3857; original triangles and feature IDs retained. Heights derived from decoded vertices. Storeys and OBJECTID are not supplied by this feed.' },
        objTransformation: { coordinateAxes: 'X=east, Y=north, Z=up', originEpsg3857: origin, verticalOriginMetres: selected[0].attributes.HoeheGrund, horizontalScaleFromWebMercatorToLocalMetres: scale }, buildings: selected.map(buildingMetadataRecord) };
    return { address, displayAddress: geocode?.matchedAddress ?? address, prefix, sourceMesh, metadata, selected, obj: options.includeObj === false ? null : createObj(selected, origin, scale, metadata.objTransformation.verticalOriginMetres, address, options.neighborDistance) };
}
