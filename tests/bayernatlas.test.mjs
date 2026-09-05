import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBayernatlasTile, ecefToMercator, extractBayernatlas, TILESET } from '../import_bayernatlas.mjs';
import { buildGlb } from '../export_model_to_glb.mjs';
function fixture(batchIds = [0, 0, 0], matrix, featureId = 'TEST_BUILDING') {
    // One real triangle, interleaved POSITION and batch IDs, at the equator.
    const batch = Buffer.from(JSON.stringify({ id: [featureId], attributes: [{ roofType: '3100' }] }));
    const geometry = Buffer.alloc(48);
    [[0, 0, 0], [0, 10, 0], [0, 0, -10]].forEach((p, i) => { p.forEach((x, j) => geometry.writeFloatLE(x, i * 16 + j * 4)); geometry.writeUInt32LE(batchIds[i], i * 16 + 12); });
    const doc = { extensions: { CESIUM_RTC: { center: [6378137, 0, 0] } }, accessors: { p: { bufferView: 'b', byteOffset: 0, byteStride: 16, componentType: 5126, count: 3, type: 'VEC3' }, id: { bufferView: 'b', byteOffset: 12, byteStride: 16, componentType: 5125, count: 3, type: 'SCALAR' } }, bufferViews: { b: { buffer: 'binary_glTF', byteLength: 48 } }, materials: { m: { values: { diffuse_mat: [1, .5, .25, 1] } } }, meshes: { m: { primitives: [{ attributes: { POSITION: 'p', _BATCHID: 'id' }, material: 'm', mode: 4 }] } }, nodes: { n: { meshes: ['m'], ...(matrix ? { matrix } : {}) } }, scene: 's', scenes: { s: { nodes: ['n'] } } };
    const json = Buffer.from(JSON.stringify(doc));
    const glb = Buffer.alloc(20 + json.length + 48);
    glb.write('glTF');
    glb.writeUInt32LE(1, 4);
    glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(json.length, 12);
    json.copy(glb, 20);
    geometry.copy(glb, 20 + json.length);
    const tile = Buffer.alloc(24 + batch.length + glb.length + 1);
    tile.write('b3dm');
    tile.writeUInt32LE(1, 4);
    tile.writeUInt32LE(tile.length, 8);
    tile.writeUInt32LE(batch.length, 12);
    tile.writeUInt32LE(1, 20);
    batch.copy(tile, 24);
    glb.copy(tile, 24 + batch.length);
    return tile;
}
test('ECEF coordinates retain known WGS84 axes and height', () => {
    const a = ecefToMercator([6378237, 0, 0]);
    assert.ok(Math.abs(a[0]) < 1e-8 && Math.abs(a[1]) < 1e-8);
    assert.ok(Math.abs(a[2] - 100) < 1e-6);
});
test('legacy b3dm preserves feature, triangle, material and Y-up orientation', () => {
    const [f] = decodeBayernatlasTile(fixture(), 'fixture');
    assert.equal(f.featureId, 'TEST_BUILDING');
    assert.equal(f.vertices.length, 3);
    assert.equal(f.sourceAttributes.roofType, '3100');
    assert.deepEqual(f.vertices[0].color, [255, 128, 64]);
    assert.ok(Math.abs(f.vertices[1].position[1] - 10.0673949674) < .0001); // 10 ECEF metres north at equator
    assert.ok(Math.abs(f.vertices[2].position[0] - 10) < .0001); // -glTF Z becomes ECEF east
    assert.ok(f.vertices.every(v => v.position.every(Number.isFinite)));
    const source = { buildings: [{ featureId: f.featureId, role: 'primary', vertices: f.vertices, triangles: [[0, 1, 2]] }] };
    const metadata = { selection: { buildingCount: 1, neighborCount: 0 }, objTransformation: { originEpsg3857: [0, 0], horizontalScaleFromWebMercatorToLocalMetres: 1, verticalOriginMetres: 0 }, buildings: [{ featureId: f.featureId, role: 'primary', attributes: { gml_id: f.featureId }, distanceFromPrimaryMetres: 0, maximumDistanceFromPrimaryMetres: 0 }] };
    const result = buildGlb(source, metadata);
    assert.equal(result.buildingCount, 1);
    assert.equal(result.triangleCount, 1);
});
test('rejects malformed tile length and cross-feature triangles', () => {
    const b = fixture();
    b.writeUInt32LE(0, 8);
    assert.throws(() => decodeBayernatlasTile(b, 'fixture'), /Invalid/);
    assert.throws(() => decodeBayernatlasTile(fixture([0, 1, 0]), 'fixture'), /identities/);
});
test('node and tile transforms are applied before geographic conversion', () => {
    const node = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1];
    const tile = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1];
    const [feature] = decodeBayernatlasTile(fixture([0, 0, 0], node), 'fixture', tile);
    const expected = ecefToMercator([6378141, 0, 5]);
    for (let axis = 0; axis < 3; axis++)
        assert.ok(Math.abs(feature.vertices[0].position[axis] - expected[axis]) < 1e-8);
});

test('ADD retains parent buildings and propagates across external tilesets; REPLACE omits parent', async () => {
  const oldFetch = globalThis.fetch;
  const region = { region: [-.1,-.1,.1,.1,-100,100] };
  for (const mode of ['ADD','REPLACE']) {
    globalThis.fetch = async url => {
      const name = new URL(url).pathname.split('/').pop();
      if (name === 'tileset.json') return {ok:true,json:async()=>({root:{boundingVolume:region,refine:mode,content:{url:'parent.b3dm'},children:[{boundingVolume:region,content:{url:'nested.json'}}]}})};
      if (name === 'nested.json') return {ok:true,json:async()=>({root:{boundingVolume:region,content:{url:'middle.b3dm'},children:[{boundingVolume:region,content:{url:'child.b3dm'}}]}})};
      const bytes = fixture([0,0,0], undefined, name);
      return {ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    };
    try {
      const result = await extractBayernatlas({address:'Synthetic fixture',coordinates:{latitude:0,longitude:0},neighborDistance:100,targetSearchDistance:25,includeObj:false},null,{latitude:0,longitude:0});
      assert.deepEqual(result.metadata.buildings.map(b=>b.featureId).sort(), mode === 'ADD' ? ['child.b3dm','middle.b3dm','parent.b3dm'] : ['child.b3dm']);
      assert.ok(result.metadata.buildings.every(b=>b.maximumDistanceFromPrimaryMetres<=100));
    } finally {globalThis.fetch=oldFetch;}
  }
});
