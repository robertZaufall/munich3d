import * as THREE from "three";

type Point = [number, number];
type Tags = Record<string, string>;
type Surface = {
  osmId: string;
  name: string;
  surface: string;
  tags: Tags;
  ring: Point[];
  holes: Point[][];
};
type FacadeOpening = {
  u: number;
  y: number;
  w: number;
  h: number;
  frame?: string;
  mullions?: number;
  bay?: number;
  recess?: number;
  entrance?: boolean;
  numberLabel?: string;
  surround?: number;
  transoms?: number;
  rollerShutter?: { closed: number; color: string };
  shutters?: string;
  timber?: string;
  arched?: boolean;
};
type FacadeBalcony = {
  u: number;
  y: number;
  w: number;
  depth: number;
  solid?: boolean;
  chamfer?: number;
  inset?: number;
  canopyOnly?: boolean;
  bowedRails?: boolean;
  railingColor?: string;
  awning?: boolean;
  /** Finish thickness above an existing source terrace, to avoid coplanar decks. */
  surfaceLift?: number;
};
type FacadeFace = {
  normal: [number, number];
  offset: number;
  color?: string;
  openings: FacadeOpening[];
  balconies?: FacadeBalcony[];
  plinth?: { height: number; color: string };
  gutterHeight?: number;
  downpipes?: number[];
  flues?: { u: number; bottom: number; top: number }[];
  ivy?: { u: number; y: number; w: number; h: number }[];
};
type RoofFixture = {
  kind: "solar" | "rooflight" | "chimney" | "dish" | "dormer";
  x: number;
  z: number;
  w: number;
  h: number;
  rows?: number;
  columns?: number;
  color?: string;
};
type FacadeProfile = {
  gmlId: string;
  roofColor?: string;
  tiledRoof?: boolean;
  roofFinish?: "tiles" | "corrugated";
  roofFixtures?: RoofFixture[];
  mergeWallFragments?: boolean;
  wallColor: string;
  frameColor: string;
  cameraDirection: [number, number];
  notes: string;
  references: { title: string; url: string }[];
  faces: FacadeFace[];
};
type SurfaceData = {
  primaryFacade?: FacadeProfile;
  connectedFacades?: FacadeProfile[];
  /** Independently addressed neighbours: detailing must not change visibility roles. */
  neighborFacades?: FacadeProfile[];
  architectureStyle?: "generic" | "gothic";
  bounds: [number, number, number, number];
  anchors: { bounds: [number, number, number, number]; height: number }[];
  surfaces: Surface[];
  lines: { points: Point[]; width: number; tags: Tags; surface: string }[];
  points: { point: Point; name: string; tags: Tags }[];
};
export type ReconstructionStats = {
  windows: number;
  architecturalParts: number;
  pavingStones: number;
  roofTiles: number;
  mappedSurfaces: number;
  trees: number;
  railwayTracks: number;
  railSleepers: number;
  kerbStones: number;
  streetFurniture: number;
  facadeReference?: {
    notes: string;
    references: { title: string; url: string }[];
  };
};
const up = new THREE.Vector3(0, 1, 0);
const box = new THREE.BoxGeometry(1, 1, 1);
const dummy = new THREE.Object3D();
const color = new THREE.Color();
const stone = new THREE.MeshStandardMaterial({
  color: 0xb9aa90,
  roughness: 0.93,
});
const trim = new THREE.MeshStandardMaterial({
  color: 0xe0d4b9,
  roughness: 0.82,
});
const glass = new THREE.MeshStandardMaterial({
  color: 0x233b43,
  roughness: 0.25,
  metalness: 0.35,
});
const wood = new THREE.MeshStandardMaterial({
  color: 0x493b2b,
  roughness: 0.86,
});
const metal = new THREE.MeshStandardMaterial({
  color: 0x3b514f,
  roughness: 0.55,
  metalness: 0.5,
});
const paving = new THREE.MeshStandardMaterial({
  color: 0xb2aca0,
  roughness: 1,
});
const foliage = new THREE.MeshStandardMaterial({
  color: 0x546841,
  roughness: 1,
});
const gold = new THREE.MeshStandardMaterial({
  color: 0xbd9745,
  roughness: 0.38,
  metalness: 0.72,
});
// Shared base geometries/materials live for the app lifetime. Per-scene instances
// receive clones, so disposing one viewer cannot invalidate another viewer.
type Placement = {
  position: THREE.Vector3;
  scale: THREE.Vector3;
  quaternion: THREE.Quaternion;
  shade: number;
};
class Batch {
  items: Placement[] = [];
  constructor(
    public geometry: THREE.BufferGeometry,
    public material: THREE.MeshStandardMaterial,
  ) {}
  add(
    position: THREE.Vector3,
    scale: THREE.Vector3,
    quaternion = new THREE.Quaternion(),
    shade = 1,
  ) {
    this.items.push({
      position: position.clone(),
      scale: scale.clone(),
      quaternion: quaternion.clone(),
      shade,
    });
  }
  flush(parent: THREE.Object3D, name: string, shadow = true) {
    if (!this.items.length) return;
    const mesh = new THREE.InstancedMesh(
      this.geometry.clone(),
      this.material.clone(),
      this.items.length,
    );
    mesh.name = name;
    mesh.userData.reconstructed = true;
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];
      dummy.position.copy(p.position);
      dummy.scale.copy(p.scale);
      dummy.quaternion.copy(p.quaternion);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.setRGB(p.shade, p.shade, p.shade));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    parent.add(mesh);
  }
}
function contains(p: Point, ring: Point[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}
function insideSurface(p: Point, s: Surface) {
  return contains(p, s.ring) && !s.holes.some((h) => contains(p, h));
}
function heightField(data: SurfaceData) {
  return (x: number, z: number) => {
    let total = 0,
      weights = 0;
    for (const a of data.anchors) {
      const dx = Math.max(a.bounds[0] - x, 0, x - a.bounds[2]),
        dz = Math.max(a.bounds[1] - z, 0, z - a.bounds[3]);
      const weight = 1 / (dx * dx + dz * dz + 9);
      total += a.height * weight;
      weights += weight;
    }
    return total / weights - 0.12;
  };
}
function polygonMesh(
  s: Surface,
  height: (x: number, z: number) => number,
  material: THREE.Material,
  offset: number,
) {
  const shape = new THREE.Shape(
    s.ring.map(([x, z]) => new THREE.Vector2(x, -z)),
  );
  for (const hole of s.holes)
    shape.holes.push(
      new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))),
    );
  const geometry = new THREE.ShapeGeometry(shape);
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i),
      z = -positions.getY(i);
    positions.setXYZ(i, x, height(x, z) + offset, z);
  }
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = s.name || s.osmId;
  mesh.receiveShadow = true;
  mesh.userData.osmId = s.osmId;
  return mesh;
}
function decorateTransport(
  data: SurfaceData,
  environment: THREE.Group,
  stats: ReconstructionStats,
) {
  const height = heightField(data),
    [xmin, zmin, xmax, zmax] = data.bounds;
  const make = (color: number, roughness = 0.9, metalness = 0) =>
    new Batch(
      box,
      new THREE.MeshStandardMaterial({ color, roughness, metalness }),
    );
  const kerbs = make(0xc6c4b9),
    tiles = make(0xa7a89f),
    gutters = make(0x767e80),
    paint = make(0xeee8d5),
    steel = make(0x89999f, 0.28, 0.8),
    sleepers = make(0x8c887c),
    ballast = make(0x697069),
    furniture = make(0x414b4d, 0.65, 0.4),
    timber = make(0x967650);
  const bounded = (x: number, z: number, margin = 0) =>
    x >= xmin + margin &&
    x <= xmax - margin &&
    z >= zmin + margin &&
    z <= zmax - margin;
  const obstructed = (x: number, z: number) =>
    data.anchors.some(
      (a) =>
        x > a.bounds[0] - 0.15 &&
        x < a.bounds[2] + 0.15 &&
        z > a.bounds[1] - 0.15 &&
        z < a.bounds[3] + 0.15,
    );
  type Line = SurfaceData["lines"][number];
  const isRoad = (l: Line) =>
    [
      "primary",
      "secondary",
      "tertiary",
      "residential",
      "unclassified",
      "living_street",
      "service",
    ].includes(l.tags.highway);
  const roads = data.lines.filter(isRoad),
    walks = data.lines.filter((l) =>
      ["footway", "path", "pedestrian"].includes(l.tags.highway),
    );
  const nearLine = (p: Point, l: Line) => {
    let nearest = Infinity;
    for (let i = 1; i < l.points.length; i++) {
      const a = l.points[i - 1],
        b = l.points[i],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        den = dx * dx + dz * dz;
      const t = den
        ? THREE.MathUtils.clamp(
            ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / den,
            0,
            1,
          )
        : 0;
      nearest = Math.min(
        nearest,
        Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t),
      );
    }
    return nearest;
  };
  const atJunction = (p: Point, line: Line) =>
    roads.some(
      (other) => other !== line && nearLine(p, other) < other.width / 2 + 0.25,
    );
  const crosses = (p: Point) =>
    data.points.some(
      (n) =>
        n.tags.highway === "crossing" &&
        Math.hypot(p[0] - n.point[0], p[1] - n.point[1]) < 2.2,
    );
  const put = (
    batch: Batch,
    x: number,
    z: number,
    w: number,
    h: number,
    len: number,
    y: number,
    q: THREE.Quaternion,
    shade = 1,
  ) => {
    if (!bounded(x, z, Math.hypot(w, len) / 2)) return;
    batch.add(
      new THREE.Vector3(x, height(x, z) + y, z),
      new THREE.Vector3(w, h, len),
      q,
      shade,
    );
  };
  // Constant-distance stations prevent sleeper/kerb patterns restarting at each
  // source vertex. Short segments preserve the measured polyline through bends.
  const stations = (
    line: Line,
    step: number,
    visit: (p: Point, dx: number, dz: number, s: number) => void,
  ) => {
    let total = 0,
      next = step / 2;
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1],
        b = line.points[i],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.001) continue;
      const dx = (b[0] - a[0]) / length,
        dz = (b[1] - a[1]) / length;
      while (next < total + length) {
        const t = next - total;
        visit([a[0] + dx * t, a[1] + dz * t], dx, dz, next);
        next += step;
      }
      total += length;
    }
  };
  for (const line of data.lines) {
    if (line.tags.railway) {
      if (
        !["tram", "rail", "light_rail", "narrow_gauge"].includes(
          line.tags.railway,
        ) ||
        line.tags.tunnel === "yes" ||
        Number(line.tags.layer ?? 0) < 0
      )
        continue;
      const gauge = Number.parseFloat(line.tags.gauge) / 1000 || 1.435;
      if (gauge < 0.5 || gauge > 2.5) continue;
      stats.railwayTracks++;
      stations(line, 0.65, ([x, z], dx, dz) => {
        const q = new THREE.Quaternion().setFromAxisAngle(
          up,
          Math.atan2(dx, dz),
        );
        const embedded =
          line.tags.embedded === "yes" ||
          roads.some((r) => nearLine([x, z], r) < r.width / 2);
        if (!embedded) {
          put(
            ballast,
            x,
            z,
            gauge + 1.2,
            0.12,
            0.67,
            0.19,
            q,
            0.92 + 0.08 * Math.sin(x + z),
          );
          put(sleepers, x, z, gauge + 0.8, 0.13, 0.21, 0.29, q);
        }
        for (const side of [-1, 1]) {
          const rx = x + ((dz * gauge) / 2) * side,
            rz = z - ((dx * gauge) / 2) * side;
          put(steel, rx, rz, 0.075, 0.08, 0.69, embedded ? 0.235 : 0.39, q);
          // Foot of the rail is separately modeled below its polished running head.
          put(furniture, rx, rz, 0.14, 0.045, 0.69, embedded ? 0.2 : 0.33, q);
        }
      });
      continue;
    }
    const road = isRoad(line),
      footway = ["footway", "path", "pedestrian", "cycleway"].includes(
        line.tags.highway,
      );
    if (!road && !footway) continue;
    stations(line, 0.8, ([x, z], dx, dz, station) => {
      const q = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(dx, dz));
      for (const side of [-1, 1]) {
        const edge = line.width / 2;
        const ex = x + dz * edge * side,
          ez = z - dx * edge * side;
        if (
          atJunction([ex, ez], line) ||
          obstructed(ex, ez) ||
          data.surfaces.some(
            (s) =>
              ["pedestrian", "platform"].includes(
                s.tags.highway ?? s.tags.railway,
              ) && insideSurface([ex, ez], s),
          )
        )
          continue;
        const lowered = crosses([ex, ez]);
        put(
          kerbs,
          ex,
          ez,
          road ? 0.18 : 0.1,
          lowered ? 0.05 : 0.18,
          0.775,
          lowered ? 0.18 : 0.24,
          q,
          0.96 + 0.04 * Math.sin(station),
        );
        if (road) {
          put(
            gutters,
            x + dz * (edge - 0.25) * side,
            z - dx * (edge - 0.25) * side,
            0.28,
            0.025,
            0.78,
            0.19,
            q,
          );
          if (Math.floor(station / 0.8) % 30 === 0 && !lowered) {
            for (let slat = 0; slat < 5; slat++)
              put(
                furniture,
                x + dz * (edge - 0.25) * side + dx * (slat - 0.2 * 5) * 0.085,
                z - dx * (edge - 0.25) * side + dz * (slat - 1) * 0.085,
                0.26,
                0.02,
                0.025,
                0.211,
                q,
              );
          }
          const sidewalk = line.tags.sidewalk;
          const enabled =
            sidewalk === "both" ||
            sidewalk === "yes" ||
            (side === 1 && sidewalk === "left") ||
            (side === -1 && sidewalk === "right");
          if (enabled)
            for (let col = 0; col < 3; col++) {
              const across = edge + 0.15 + (col + 0.5) * 0.6,
                px = x + dz * across * side,
                pz = z - dx * across * side;
              if (
                obstructed(px, pz) ||
                atJunction([px, pz], line) ||
                walks.some((l) => nearLine([px, pz], l) < l.width / 2 + 0.25) ||
                data.lines.some(
                  (l) => l.tags.railway && nearLine([px, pz], l) < 1.5,
                )
              )
                continue;
              put(
                tiles,
                px,
                pz,
                0.58,
                0.085,
                0.775,
                0.26,
                q,
                0.9 + 0.1 * (Math.sin(station * 19 + col * 7) * 0.5 + 0.5),
              );
            }
        }
      }
      // Lane count comes from OSM. Marking dimensions remain illustrative.
      const lanes = Number.parseInt(line.tags.lanes, 10);
      if (
        road &&
        lanes >= 2 &&
        lanes <= 6 &&
        Math.floor(station / 3) % 2 === 0 &&
        !atJunction([x, z], line) &&
        !crosses([x, z])
      )
        for (let lane = 1; lane < lanes; lane++) {
          const offset = -line.width / 2 + (line.width * lane) / lanes;
          put(
            paint,
            x + dz * offset,
            z - dx * offset,
            0.1,
            0.012,
            0.81,
            0.192,
            q,
          );
        }
    });
  }
  // Platform perimeter blocks and tactile strips follow actual platform polygons.
  for (const s of data.surfaces) {
    const platform = s.tags.railway === "platform";
    if (!platform && !["paving_stones", "sett"].includes(s.surface)) continue;
    for (const ring of [s.ring, ...s.holes]) {
      const line = {
        points: [...ring, ring[0]],
        width: 0,
        tags: {},
        surface: "",
      };
      stations(line, 0.65, ([x, z], dx, dz) => {
        const q = new THREE.Quaternion().setFromAxisAngle(
          up,
          Math.atan2(dx, dz),
        );
        put(
          kerbs,
          x,
          z,
          platform ? 0.28 : 0.16,
          platform ? 0.2 : 0.055,
          0.63,
          platform ? 0.25 : 0.15,
          q,
        );
        if (platform && s.tags.tactile_paving === "yes") {
          // Keep the ribbed safety band inside the mapped platform footprint.
          for (const side of [-1, 1]) {
            const px = x + dz * 0.4 * side,
              pz = z - dx * 0.4 * side;
            if (!insideSurface([px, pz], s)) continue;
            for (let rib = 0; rib < 4; rib++)
              put(
                paint,
                px + dz * (rib - 1.5) * 0.075,
                pz - dx * (rib - 1.5) * 0.075,
                0.035,
                0.02,
                0.6,
                0.34,
                q,
              );
          }
        }
      });
    }
  }
  for (const p of data.points) {
    const [x, z] = p.point;
    if (!bounded(x, z, 1)) continue;
    const nearest = roads
      .map((line) => ({ line, d: nearLine(p.point, line) }))
      .sort((a, b) => a.d - b.d)[0];
    const q = new THREE.Quaternion();
    if (p.tags.amenity === "bench") {
      const compass = [
        "N",
        "NNE",
        "NE",
        "ENE",
        "E",
        "ESE",
        "SE",
        "SSE",
        "S",
        "SSW",
        "SW",
        "WSW",
        "W",
        "WNW",
        "NW",
        "NNW",
      ];
      const named = compass.indexOf((p.tags.direction ?? "").toUpperCase());
      let angle =
        named >= 0
          ? named * 22.5
          : p.tags.direction?.trim()
            ? Number(p.tags.direction)
            : NaN;
      const mapped = Number.isFinite(angle);
      if (!mapped) {
        // Unknown bearings face the nearest walkway, or the rail on a platform.
        const platform = data.surfaces.some(
          (s) => s.tags.railway === "platform" && insideSurface(p.point, s),
        );
        const candidates = platform
          ? data.lines.filter((l) => l.tags.railway === "tram")
          : walks;
        let best = Infinity;
        angle = 0;
        for (const line of candidates)
          for (let i = 1; i < line.points.length; i++) {
            const a = line.points[i - 1],
              b = line.points[i],
              dx = b[0] - a[0],
              dz = b[1] - a[1],
              den = dx * dx + dz * dz;
            if (!den) continue;
            const t = THREE.MathUtils.clamp(
                ((x - a[0]) * dx + (z - a[1]) * dz) / den,
                0,
                1,
              ),
              vx = a[0] + t * dx - x,
              vz = a[1] + t * dz - z,
              d = Math.hypot(vx, vz);
            if (d > 0.05 && d < best) {
              best = d;
              angle = THREE.MathUtils.radToDeg(Math.atan2(vx, -vz));
            }
          }
      }
      // Bench front is local -Z. Compass bearings turn clockwise from north,
      // hence the negative Three.js Y rotation in the east/up/south frame.
      q.setFromAxisAngle(up, -THREE.MathUtils.degToRad(angle));
      const benchSeat =
        p.tags.material === "metal" || p.tags.colour === "black"
          ? furniture
          : timber;
      const physicalFront = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      (environment.userData.benchOrientations ??= []).push({
        point: p.point,
        bearing: angle,
        mapped,
        front: physicalFront.toArray(),
        backrest: p.tags.backrest !== "no",
      });
      for (let i = 0; i < 5; i++) {
        const offset = new THREE.Vector3(0, 0, (i - 2) * 0.09).applyQuaternion(
          q,
        );
        put(benchSeat, x + offset.x, z + offset.z, 1.8, 0.075, 0.075, 0.65, q);
      }
      for (const side of [-1, 1]) {
        const leg = new THREE.Vector3(side * 0.65, 0, 0).applyQuaternion(q);
        put(furniture, x + leg.x, z + leg.z, 0.075, 0.5, 0.42, 0.4, q);
      }
      const back = new THREE.Vector3(0, 0, 0.23).applyQuaternion(q);
      if (p.tags.backrest !== "no")
        for (let i = 0; i < 3; i++)
          put(
            benchSeat,
            x + back.x,
            z + back.z,
            1.8,
            0.095,
            0.07,
            0.85 + i * 0.12,
            q,
          );
      stats.streetFurniture++;
    }
    if (p.tags.highway === "street_lamp") {
      put(furniture, x, z, 0.1, 5.7, 0.1, 3.1, q);
      put(steel, x + 0.35, z, 0.8, 0.12, 0.3, 6, q);
      stats.streetFurniture++;
    }
    if (p.tags.amenity === "waste_basket") {
      put(furniture, x, z, 0.42, 0.85, 0.42, 0.65, q);
      stats.streetFurniture++;
    }
    if (
      p.tags.highway === "crossing" &&
      nearest &&
      nearest.d < nearest.line.width / 2 + 1
    ) {
      const l = nearest.line;
      let best = { d: Infinity, dx: 0, dz: 1 };
      for (let i = 1; i < l.points.length; i++) {
        const a = l.points[i - 1],
          b = l.points[i],
          len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!len) continue;
        const dx = (b[0] - a[0]) / len,
          dz = (b[1] - a[1]) / len,
          t = THREE.MathUtils.clamp((x - a[0]) * dx + (z - a[1]) * dz, 0, len),
          d = Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
        if (d < best.d) best = { d, dx, dz };
      }
      q.setFromAxisAngle(up, Math.atan2(best.dx, best.dz));
      if (
        p.tags.crossing === "zebra" ||
        p.tags["crossing:markings"] === "zebra"
      )
        for (let o = -l.width / 2 + 0.35; o < l.width / 2; o += 0.8)
          put(
            paint,
            x + best.dz * o,
            z - best.dx * o,
            0.4,
            0.012,
            2.6,
            0.195,
            q,
          );
      if (p.tags.crossing === "traffic_signals")
        for (const side of [-1, 1]) {
          const px = x + best.dz * (l.width / 2 + 0.4) * side,
            pz = z - best.dx * (l.width / 2 + 0.4) * side;
          put(furniture, px, pz, 0.07, 2.7, 0.07, 1.6, q);
          put(furniture, px, pz, 0.22, 0.65, 0.2, 2.8, q);
          stats.streetFurniture++;
        }
    }
  }
  stats.pavingStones += tiles.items.length;
  stats.kerbStones = kerbs.items.length;
  stats.railSleepers = sleepers.items.length;
  kerbs.flush(environment, "Jointed kerbstones and platform edges");
  tiles.flush(environment, "Sidewalk paving modules");
  gutters.flush(environment, "Stone drainage channels");
  paint.flush(environment, "Mapped lane and platform markings", false);
  steel.flush(environment, "Rail heads and metal street details");
  sleepers.flush(environment, "Rail sleepers");
  ballast.flush(environment, "Ballast track beds");
  furniture.flush(environment, "Rail feet, drains and street furniture");
  timber.flush(environment, "Bench timber slats");
}

function buildGround(data: SurfaceData, stats: ReconstructionStats) {
  const environment = new THREE.Group();
  environment.name = "Reconstructed mapped surfaces";
  const height = heightField(data),
    [xmin, zmin, xmax, zmax] = data.bounds;
  const terrain = new THREE.PlaneGeometry(xmax - xmin, zmax - zmin, 80, 80);
  terrain.rotateX(-Math.PI / 2);
  terrain.translate((xmin + xmax) / 2, 0, (zmin + zmax) / 2);
  const positions = terrain.getAttribute("position");
  for (let i = 0; i < positions.count; i++)
    positions.setY(i, height(positions.getX(i), positions.getZ(i)) - 0.04);
  terrain.computeVertexNormals();
  const base = new THREE.Mesh(
    terrain,
    new THREE.MeshStandardMaterial({ color: 0x8e8a7c, roughness: 1 }),
  );
  base.receiveShadow = true;
  environment.add(base);
  const slabs = new Batch(box, paving),
    curbs = new Batch(box, trim),
    trunks = new Batch(new THREE.CylinderGeometry(0.22, 0.35, 1, 7), wood),
    crowns = new Batch(new THREE.IcosahedronGeometry(1, 1), foliage);
  const roads = new Batch(
    box,
    new THREE.MeshStandardMaterial({ color: 0x464d50, roughness: 1 }),
  );
  const paths = new Batch(box, paving);
  const roadVertices: number[] = [],
    pathVertices: number[] = [];
  const bounded = (x: number, z: number) =>
    x >= xmin && x <= xmax && z >= zmin && z <= zmax;
  const mappedPaving = data.surfaces.filter((s) =>
    ["paving_stones", "sett"].includes(s.surface),
  );
  const carriageways = data.lines.filter((l) =>
    [
      "primary",
      "secondary",
      "tertiary",
      "residential",
      "unclassified",
      "living_street",
      "service",
    ].includes(l.tags.highway),
  );
  const onCarriageway = (x: number, z: number) =>
    carriageways.some((l) =>
      l.points.some((b, i) => {
        if (!i) return false;
        const a = l.points[i - 1],
          dx = b[0] - a[0],
          dz = b[1] - a[1],
          den = dx * dx + dz * dz;
        const t = den
          ? THREE.MathUtils.clamp(
              ((x - a[0]) * dx + (z - a[1]) * dz) / den,
              0,
              1,
            )
          : 0;
        return (
          Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < l.width / 2 + 0.05
        );
      }),
    );
  // Road centre lines have estimated width unless OSM supplies width. Do not
  // draw underground passages or duplicate pedestrian routing across a plaza.
  for (const line of data.lines) {
    if (line.tags.railway) continue;
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1],
        b = line.points[i],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz);
      if (length < 0.1) continue;
      const count = Math.ceil(length / 2);
      for (let j = 0; j < count; j++) {
        const t = (j + 0.5) / count,
          x = a[0] + dx * t,
          z = a[1] + dz * t;
        if (
          !bounded(x, z) ||
          (["footway", "path", "cycleway", "steps"].includes(
            line.tags.highway,
          ) &&
            onCarriageway(x, z)) ||
          mappedPaving.some((s) => insideSurface([x, z], s))
        )
          continue;
        const q = new THREE.Quaternion().setFromAxisAngle(
          up,
          Math.atan2(dx, dz),
        );
        const vertices =
          line.surface === "asphalt" ? roadVertices : pathVertices;
        const corners = [-1, 1].flatMap((along) =>
          [-1, 1].map((across) => {
            const px = THREE.MathUtils.clamp(
              x +
                (across * line.width * 0.5 * dz) / length +
                (along * dx) / (2 * count),
              xmin,
              xmax,
            );
            const pz = THREE.MathUtils.clamp(
              z -
                (across * line.width * 0.5 * dx) / length +
                (along * dz) / (2 * count),
              zmin,
              zmax,
            );
            // Paved access ways can overlap asphalt at driveway junctions.
            // Give their surface a small physical step instead of submitting
            // differently colored triangles at the same depth.
            const surfaceHeight = line.surface === "asphalt" ? 0.18 : 0.21;
            return [px, height(px, pz) + surfaceHeight, pz];
          }),
        );
        for (const k of [0, 2, 3, 0, 3, 1]) vertices.push(...corners[k]);
        if (["paving_stones", "sett"].includes(line.surface)) {
          const columns = Math.max(1, Math.floor(line.width / 0.65));
          const cellWidth = line.width / columns;
          const segmentLength = length / count;
          const rows = Math.max(1, Math.ceil(segmentLength / 0.65));
          for (let row = 0; row < rows; row++)
            for (let column = 0; column < columns; column++) {
              const across = (column + 0.5) * cellWidth - line.width / 2;
              const along =
                ((row + 0.5) * segmentLength) / rows - segmentLength / 2;
              const px = x + (across * dz) / length + (along * dx) / length;
              const pz = z - (across * dx) / length + (along * dz) / length;
              if (
                !bounded(px, pz) ||
                onCarriageway(px, pz) ||
                mappedPaving.some((s) => insideSurface([px, pz], s))
              )
                continue;
              slabs.add(
                new THREE.Vector3(px, height(px, pz) + 0.2, pz),
                new THREE.Vector3(
                  cellWidth - 0.025,
                  0.075,
                  segmentLength / rows - 0.025,
                ),
                q,
              );
            }
        }
      }
    }
  }
  for (const s of data.surfaces) {
    const water = s.tags.natural === "water",
      construction = s.tags.landuse === "construction",
      grass =
        ["grass", "meadow"].includes(s.tags.landuse) ||
        s.tags.natural === "wood" ||
        s.tags.leisure === "park";
    const surfaceColor = water
      ? 0x49766f
      : construction
        ? 0x8b7860
        : grass
          ? 0x66734c
          : s.surface === "asphalt"
            ? 0x464d50
            : 0x928d82;
    environment.add(
      polygonMesh(
        s,
        height,
        new THREE.MeshStandardMaterial({
          color: surfaceColor,
          roughness: water ? 0.22 : 1,
          metalness: water ? 0.2 : 0,
        }),
        s.tags.railway === "platform" ? 0.25 : 0.08,
      ),
    );
    if (["paving_stones", "sett"].includes(s.surface)) {
      const xs = s.ring.map((p) => p[0]),
        zs = s.ring.map((p) => p[1]);
      const stepX = s.surface === "sett" ? 0.55 : 0.95,
        stepZ = s.surface === "sett" ? 0.45 : 0.65;
      let row = 0;
      for (let z = Math.min(...zs); z < Math.max(...zs); z += stepZ, row++)
        for (
          let x = Math.min(...xs) + ((row % 2) * stepX) / 2;
          x < Math.max(...xs);
          x += stepX
        ) {
          const corners: Point[] = [
            [x - stepX / 2, z - stepZ / 2],
            [x + stepX / 2, z - stepZ / 2],
            [x + stepX / 2, z + stepZ / 2],
            [x - stepX / 2, z + stepZ / 2],
          ];
          if (!corners.every((p) => insideSurface(p, s))) continue;
          const shade =
            0.88 +
            (0.16 *
              (((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1) + 1)) /
              2;
          slabs.add(
            new THREE.Vector3(
              x,
              height(x, z) + (s.tags.railway === "platform" ? 0.29 : 0.1),
              z,
            ),
            new THREE.Vector3(stepX - 0.025, 0.075, stepZ - 0.025),
            undefined,
            shade,
          );
        }
    }
    // Raised edge stones are explicit objects, including the fountain basin.
    if (water || s.tags.landuse === "grass")
      for (let i = 0; i < s.ring.length; i++) {
        const a = s.ring[i],
          b = s.ring[(i + 1) % s.ring.length],
          dx = b[0] - a[0],
          dz = b[1] - a[1];
        const x = (a[0] + b[0]) / 2,
          z = (a[1] + b[1]) / 2;
        curbs.add(
          new THREE.Vector3(x, height(x, z) + (water ? 0.5 : 0.15), z),
          new THREE.Vector3(
            water ? 0.38 : 0.18,
            water ? 0.85 : 0.25,
            Math.hypot(dx, dz),
          ),
          new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(dx, dz)),
        );
      }
  }
  for (const p of data.points) {
    const [x, z] = p.point,
      y = height(x, z);
    if (p.tags.natural === "tree") {
      trunks.add(
        new THREE.Vector3(x, y + 2.3, z),
        new THREE.Vector3(1, 4.6, 1),
      );
      crowns.add(
        new THREE.Vector3(x, y + 5.3, z),
        new THREE.Vector3(2.6, 3.1, 2.6),
        undefined,
        0.82 + (Math.abs(x) % 3) / 12,
      );
      stats.trees++;
    }
    if (p.name === "Mariensäule") {
      const monument = new THREE.Group();
      monument.name = "Mariensäule · approximate form at mapped position";
      monument.position.set(x, y, z);
      const add = (g: THREE.BufferGeometry, m: THREE.Material, h: number) => {
        const mesh = new THREE.Mesh(g, m);
        mesh.position.y = h;
        mesh.castShadow = true;
        monument.add(mesh);
      };
      add(new THREE.BoxGeometry(3.7, 0.4, 3.7), stone.clone(), 0.2);
      add(new THREE.BoxGeometry(2.6, 1.7, 2.6), stone.clone(), 1.15);
      add(new THREE.CylinderGeometry(0.5, 0.6, 9.5, 20), stone.clone(), 6.75);
      add(new THREE.CylinderGeometry(0.85, 0.55, 0.5, 12), gold.clone(), 11.7);
      add(new THREE.ConeGeometry(0.4, 1.6, 10), gold.clone(), 12.8);
      add(new THREE.SphereGeometry(0.22, 10, 8), gold.clone(), 13.7);
      environment.add(monument);
    }
  }
  stats.pavingStones = slabs.items.length;
  slabs.flush(environment, "Individual paving stones", false);
  curbs.flush(environment, "Raised surface edges");
  trunks.flush(environment, "Mapped tree trunks");
  crowns.flush(environment, "Mapped tree crowns");
  for (const [vertices, material, name] of [
    [roadVertices, roads.material, "Continuous graded asphalt"],
    [pathVertices, paths.material, "Continuous graded paths"],
  ] as const) {
    if (!vertices.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material.clone());
    mesh.name = name;
    mesh.receiveShadow = true;
    environment.add(mesh);
  }
  decorateTransport(data, environment, stats);
  return environment;
}

type Wall = {
  normal: THREE.Vector3;
  tangent: THREE.Vector3;
  offset: number;
  triangles: THREE.Triangle[];
  minU: number;
  maxU: number;
  minY: number;
  maxY: number;
};
function wallPlanes(mesh: THREE.Mesh) {
  const g = mesh.geometry,
    p = g.getAttribute("position"),
    index = g.index;
  const groups = new Map<string, Wall>();
  const count = index ? index.count : p.count;
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    normal = new THREE.Vector3();
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(p, index ? index.getX(i) : i);
    b.fromBufferAttribute(p, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(p, index ? index.getX(i + 2) : i + 2);
    THREE.Triangle.getNormal(a, b, c, normal);
    if (Math.abs(normal.y) > 0.08) continue;
    normal.y = 0;
    normal.normalize();
    const d = normal.dot(a),
      tangent = new THREE.Vector3(normal.z, 0, -normal.x);
    const key = [normal.x.toFixed(3), normal.z.toFixed(3), d.toFixed(1)].join(
      "/",
    );
    let wall = groups.get(key);
    if (!wall) {
      wall = {
        normal: normal.clone(),
        tangent,
        offset: d,
        triangles: [],
        minU: Infinity,
        maxU: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
      };
      groups.set(key, wall);
    }
    wall.triangles.push(new THREE.Triangle(a.clone(), b.clone(), c.clone()));
    for (const v of [a, b, c]) {
      const u = v.dot(wall.tangent);
      wall.minU = Math.min(wall.minU, u);
      wall.maxU = Math.max(wall.maxU, u);
      wall.minY = Math.min(wall.minY, v.y);
      wall.maxY = Math.max(wall.maxY, v.y);
    }
  }
  return [...groups.values()];
}
// Subtract an axis-aligned opening from a projected source triangle. The
// outside fragments preserve the original wall outline, including steps.
function subtractOpening(
  polygon: Point[],
  r: [number, number, number, number],
) {
  let inside = polygon;
  const outside: Point[][] = [];
  for (const [axis, limit, sign] of [
    [0, r[0], 1],
    [0, r[2], -1],
    [1, r[1], 1],
    [1, r[3], -1],
  ]) {
    const clip = (keep: number) => {
      const out: Point[] = [];
      for (let i = 0; i < inside.length; i++) {
        const a = inside[i],
          b = inside[(i + 1) % inside.length];
        const da = (a[axis] - limit) * sign * keep,
          db = (b[axis] - limit) * sign * keep;
        if (da >= 0) out.push(a);
        if (da >= 0 !== db >= 0) {
          const t = da / (da - db);
          out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        }
      }
      return out;
    };
    const fragment = clip(-1);
    if (fragment.length >= 3) outside.push(fragment);
    inside = clip(1);
    if (inside.length < 3) break;
  }
  return outside;
}
function referenceFacade(
  mesh: THREE.Mesh,
  stats: ReconstructionStats,
  profile: FacadeProfile,
) {
  const group = new THREE.Group();
  group.name = "Reference-based façade · estimated dimensions";
  group.userData.reconstructed = true;
  const mat = (c: string) =>
    new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.83,
      side: THREE.DoubleSide,
    });
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const batches = new Map<string, Batch>();
  const batch = (c: string) => {
    if (!batches.has(c)) {
      const m = mat(c);
      materials.set(c, m);
      batches.set(c, new Batch(box, m));
    }
    return batches.get(c)!;
  };
  // Decoder rounding can split one physical plane into several triangle groups.
  // Consolidate these only in the illustrative wall, so frames are not drawn twice.
  const referenceWalls: Wall[] = [];
  for (const candidate of wallPlanes(mesh)) {
    const existing = profile.mergeWallFragments && referenceWalls.find(w => w.normal.dot(candidate.normal) > 0.999998 && Math.abs(w.offset - candidate.offset) < 0.02);
    if (!existing) { referenceWalls.push(candidate); continue; }
    existing.triangles.push(...candidate.triangles);
    for (const t of candidate.triangles) for (const v of [t.a, t.b, t.c]) {
      existing.minU = Math.min(existing.minU, v.dot(existing.tangent));
      existing.maxU = Math.max(existing.maxU, v.dot(existing.tangent));
      existing.minY = Math.min(existing.minY, v.y);
      existing.maxY = Math.max(existing.maxY, v.y);
    }
  }
  for (const wall of referenceWalls) {
    const face = profile.faces.filter(
      (f) =>
        wall.normal.x * f.normal[0] + wall.normal.z * f.normal[1] > 0.999 &&
        Math.abs(wall.offset - f.offset) < 0.22,
    ).sort((a, b) => Math.abs(wall.offset - a.offset) - Math.abs(wall.offset - b.offset))[0];
    const openings = face?.openings ?? [];
    const wallColor = face?.color ?? profile.wallColor;
    const rotation = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(wall.tangent, up, wall.normal),
    );
    const locate = (u: number, y: number, d: number) =>
      wall.tangent
        .clone()
        .multiplyScalar(u)
        .addScaledVector(wall.normal, wall.offset + d)
        .setY(y);
    const part = (
      c: string,
      u: number,
      y: number,
      w: number,
      h: number,
      depth: number,
      out: number,
    ) =>
      batch(c).add(locate(u, y, out), new THREE.Vector3(w, h, depth), rotation);
    const glassColor = "#35464b";
    const fits = (o: FacadeOpening) =>
      o.u + o.w / 2 > wall.minU &&
      o.u - o.w / 2 < wall.maxU &&
      o.y + o.h / 2 > wall.minY &&
      o.y - o.h / 2 < wall.maxY;
    const active = openings.filter(fits);
    const crown = (o: FacadeOpening, x: number) => o.y + o.h / 2 -
      (o.arched ? o.w * 0.22 * (1 - Math.sqrt(Math.max(0, 1 - (2 * x / o.w) ** 2))) : 0);
    const positions: number[] = [];
    for (const t of wall.triangles) {
      let polygons: Point[][] = [
        [t.a, t.b, t.c].map((v) => [v.dot(wall.tangent), v.y] as Point),
      ];
      for (const o of active) {
        const strips = o.arched ? 24 : 1;
        for (let i = 0; i < strips; i++) {
          const left = -o.w / 2 + o.w * i / strips;
          const right = left + o.w / strips;
          polygons = polygons.flatMap((poly) => subtractOpening(poly, [
            o.u + left, o.y - o.h / 2, o.u + right,
            crown(o, (left + right) / 2),
          ]));
        }
      }
      for (const poly of polygons)
        for (let i = 1; i < poly.length - 1; i++)
          for (const p of [poly[0], poly[i], poly[i + 1]])
            positions.push(...locate(p[0], p[1], 0).toArray());
    }
    if (positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geometry.computeVertexNormals();
      const surface = new THREE.Mesh(geometry, mat(wallColor));
      surface.name = "Source-plane wall with geometric window openings";
      surface.castShadow = true;
      surface.receiveShadow = true;
      group.add(surface);
    }
    if (face?.plinth) {
      const { height, color: c } = face.plinth;
      for (let u = wall.minU + 0.12; u < wall.maxU; u += 0.24) {
        if (active.some(o => Math.abs(o.u - u) < o.w / 2 + 0.14 && o.y - o.h / 2 < wall.minY + height)) continue;
        part(c, u, wall.minY + height / 2, Math.min(0.24, wall.maxU - u + 0.12), height, 0.045, 0.032);
      }
    }
    if (face?.gutterHeight != null) {
      const width = wall.maxU - wall.minU, u = (wall.minU + wall.maxU) / 2;
      part("#514e41", u, face.gutterHeight, width + 0.24, 0.16, 0.23, 0.12);
      part("#747873", u, face.gutterHeight - 0.09, width + 0.28, 0.09, 0.16, 0.26);
    }
    for (const u of face?.downpipes ?? []) {
      const top = face?.gutterHeight ?? wall.maxY;
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, top - wall.minY, 8), mat("#777b73"));
      pipe.position.copy(locate(u, (top + wall.minY) / 2, 0.19));
      pipe.name = "Rainwater downpipe";
      group.add(pipe);
      for (let y = wall.minY + 0.4; y < top; y += 1.25) part("#4f524a", u, y, 0.14, 0.035, 0.06, 0.21);
    }
    for (const f of face?.flues ?? []) {
      const material = new THREE.MeshStandardMaterial({ color: "#adb5b2", metalness: 0.85, roughness: 0.28 });
      const flue = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, f.top - f.bottom, 12), material);
      flue.position.copy(locate(f.u, (f.top + f.bottom) / 2, 0.29));
      flue.name = "Stainless steel external flue";
      group.add(flue);
      for (let y = f.bottom; y < f.top; y += 1.05) part("#b7bfbc", f.u, y, 0.25, 0.035, 0.24, 0.29);
      part("#818b87", f.u, f.bottom, 0.43, 0.24, 0.42, 0.28);
    }
    for (const patch of face?.ivy ?? []) {
      const leaves = new Batch(new THREE.IcosahedronGeometry(1, 0), mat("#476131"));
      for (let i = 0; i < patch.w * patch.h * 15; i++) {
        const noise = (s: number) => Math.abs(Math.sin((i + 1) * s));
        const u = patch.u + (noise(14.317) - 0.5) * patch.w;
        const y = patch.y + (noise(7.853) - 0.5) * patch.h;
        const point = locate(u, y, 0);
        if (!wall.triangles.some(t => t.containsPoint(t.getPlane(new THREE.Plane()).projectPoint(point, new THREE.Vector3())))) continue;
        if (active.some(o => Math.abs(o.u - u) < o.w / 2 + 0.18 && Math.abs(o.y - y) < o.h / 2 + 0.18)) continue;
        leaves.add(locate(u, y, 0.12 + noise(3.31) * 0.12), new THREE.Vector3(0.13, 0.12, 0.065), rotation, 0.65 + noise(5.4) * 0.6);
      }
      stats.architecturalParts += leaves.items.length;
      leaves.flush(group, "Individual climbing ivy leaves", false);
    }
    for (const o of active) {
      // A fragmented source face may intersect an opening; only its containing
      // face owns the frame. Openings are otherwise clipped per source triangle.
      if (
        o.u < wall.minU ||
        o.u > wall.maxU ||
        o.y < wall.minY ||
        o.y > wall.maxY
      )
        continue;
      const c = o.frame ?? profile.frameColor,
        f = 0.065,
        back = o.bay ?? -(o.recess ?? 0.18);
      part(o.timber ?? glassColor, o.u, o.y, o.w, o.h, 0.035, back);
      if (o.surround) {
        const s = o.surround;
        for (const sign of [-1, 1]) {
          part(c, o.u + sign * (o.w + s) / 2, o.y, s, o.h + 2 * s, 0.06, 0.045);
          if (!o.arched || sign < 0)
            part(c, o.u, o.y + sign * (o.h + s) / 2, o.w, s, 0.06, 0.045);
        }
      }
      if (o.timber) {
        const n = Math.ceil(o.w / 0.14);
        for (let i = 0; i < n; i++) {
          const x = -o.w / 2 + o.w * (i + 0.5) / n;
          const top = crown(o, x), bottom = o.y - o.h / 2;
          batch(o.timber).add(locate(o.u + x, (top + bottom) / 2, back + 0.04),
            new THREE.Vector3(o.w / n - 0.013, top - bottom, 0.065), rotation,
            0.78 + 0.3 * Math.abs(Math.sin(i * 8.17)));
        }
        for (const y of [o.y - o.h * 0.28, o.y + o.h * 0.22])
          part("#38352e", o.u, y, o.w * 0.94, 0.045, 0.035, back + 0.085);
        part("#252926", o.u + 0.13, o.y - 0.05, 0.045, 0.19, 0.065, back + 0.13);
      }
      part(c, o.u - o.w / 2 + f / 2, o.y, f, o.h, 0.09, back + 0.025);
      part(c, o.u + o.w / 2 - f / 2, o.y, f, o.h, 0.09, back + 0.025);
      part(c, o.u, o.y - o.h / 2 + f / 2, o.w, f, 0.09, back + 0.025);
      if (o.arched) {
        for (let i = 0; i < 24; i++) {
          const x = -o.w / 2 + o.w * (i + 0.5) / 24;
          part(c, o.u + x, crown(o, x) - f / 2, o.w / 24 + 0.006, f, 0.09, back + 0.025);
        }
      } else part(c, o.u, o.y + o.h / 2 - f / 2, o.w, f, 0.09, back + 0.025);
      for (let i = 1; i <= (o.transoms ?? 0); i++)
        part(c, o.u, o.y - o.h / 2 + o.h * i / ((o.transoms ?? 0) + 1), o.w, f, 0.09, back + 0.035);
      if (o.rollerShutter) {
        const h = o.h * THREE.MathUtils.clamp(o.rollerShutter.closed, 0, 1);
        part(c, o.u, o.y + o.h / 2 + 0.09, o.w + 0.1, 0.16, 0.13, 0.04);
        if (h > 0) part(o.rollerShutter.color, o.u, o.y + (o.h - h) / 2, o.w - 0.09, h, 0.03, back + 0.06);
        for (let y = o.y + o.h / 2 - 0.03; y > o.y + o.h / 2 - h; y -= 0.055)
          part(o.rollerShutter.color, o.u, y, o.w - 0.09, 0.05, 0.045, back + 0.09);
      }
      if (o.shutters) {
        for (const sign of [-1, 1]) {
          const u = o.u + sign * (o.w * 0.76 + 0.08);
          part(o.shutters, u, o.y, o.w * 0.47, o.h + 0.08, 0.065, 0.08);
          for (let y = o.y - o.h / 2 + 0.07; y < o.y + o.h / 2; y += 0.085)
            part(o.shutters, u, y, o.w * 0.39, 0.045, 0.055, 0.125);
          for (const y of [o.y - o.h * 0.35, o.y + o.h * 0.35])
            part("#434b40", u, y, o.w * 0.38, 0.035, 0.025, 0.16);
        }
      }
      for (let i = 1; i <= (o.mullions ?? 0); i++)
        part(
          c,
          o.u - o.w / 2 + (o.w * i) / ((o.mullions ?? 0) + 1),
          o.y,
          f,
          o.h,
          0.09,
          back + 0.025,
        );
      if (!o.bay) {
        // Four reveal surfaces connect the actual wall opening to inset glass.
        part(
          wallColor,
          o.u - o.w / 2 - 0.015,
          o.y,
          0.03,
          o.h,
          Math.abs(back) + 0.04,
          back / 2,
        );
        part(
          wallColor,
          o.u + o.w / 2 + 0.015,
          o.y,
          0.03,
          o.h,
          Math.abs(back) + 0.04,
          back / 2,
        );
        part(
          wallColor,
          o.u,
          o.y - o.h / 2 - 0.025,
          o.w,
          0.05,
          Math.abs(back) + 0.07,
          back / 2,
        );
        part(
          wallColor,
          o.u,
          o.y + o.h / 2 + 0.025,
          o.w,
          0.05,
          Math.abs(back) + 0.04,
          back / 2,
        );
      } else {
        // Chamfered oriel: front glass, angled side panes and a solid apron.
        for (const sign of [-1, 1]) {
          const a = locate(o.u + sign * (o.w / 2 + 0.45), o.y, 0),
            b = locate(o.u + (sign * o.w) / 2, o.y, back);
          const length = a.distanceTo(b),
            q = new THREE.Quaternion().setFromRotationMatrix(
              new THREE.Matrix4().makeBasis(
                b.clone().sub(a).normalize(),
                up,
                new THREE.Vector3().crossVectors(
                  b.clone().sub(a).normalize(),
                  up,
                ),
              ),
            );
          batch(glassColor).add(
            a.clone().add(b).multiplyScalar(0.5),
            new THREE.Vector3(length, o.h, 0.035),
            q,
          );
          for (const y of [o.y - o.h / 2, o.y + o.h / 2])
            batch(c).add(
              a.clone().add(b).multiplyScalar(0.5).setY(y),
              new THREE.Vector3(length, 0.07, 0.08),
              q,
            );
        }

        part(
          c,
          o.u,
          o.y - o.h / 2 - 0.04,
          o.w + 0.16,
          0.08,
          back + 0.15,
          back / 2,
        );
      }
      if (o.entrance) {
        // Small physical number strokes keep the entrance label crisp without
        // a projected photograph or an external font asset.
        const digits: Record<string, string> = {
          0: "abcedf",
          1: "bc",
          2: "abged",
          3: "abgcd",
          4: "fgbc",
          5: "afgcd",
          6: "afgecd",
          7: "abc",
          8: "abcdefg",
          9: "abfgcd",
        };
        const strokes: Record<string, [number, number, number, number]> = {
          a: [0, 0.1, 0.08, 0.012],
          b: [0.04, 0.05, 0.012, 0.1],
          c: [0.04, -0.05, 0.012, 0.1],
          d: [0, -0.1, 0.08, 0.012],
          e: [-0.04, -0.05, 0.012, 0.1],
          f: [-0.04, 0.05, 0.012, 0.1],
          g: [0, 0, 0.08, 0.012],
        };
        for (const [index, digit] of [...(o.numberLabel ?? "")].entries())
          for (const segment of digits[digit] ?? "") {
            const [x, y, w, h] = strokes[segment];
            part(
              "#c4c9c8",
              o.u - 0.53 + index * 0.12 + x,
              o.y - 0.1 + y,
              w,
              h,
              0.008,
              back + 0.026,
            );
          }
        part("#8a9695", o.u, o.y + 0.1, 0.035, 0.6, 0.07, back + 0.11);
        part("#404848", o.u + o.w / 2 + 0.17, o.y, 0.16, 0.28, 0.045, 0.06);
        part(
          "#a3a29b",
          o.u,
          o.y - o.h / 2 - 0.015,
          o.w + 0.24,
          0.065,
          0.55,
          0.13,
        );
        part(c, o.u, o.y + o.h * 0.27, o.w, 0.055, 0.09, back + 0.025);
      }
      stats.windows++;
    }
    // Continuous chamfered oriel aprons between the photographed window rows.
    for (const u of new Set(active.filter((o) => o.bay).map((o) => o.u))) {
      const rows = active
        .filter((o) => o.bay && o.u === u)
        .sort((a, b) => a.y - b.y);
      let lower = wall.minY;
      const band = (o: FacadeOpening, low: number, high: number) => {
        if (high <= low) return;
        const w = o.w,
          d = o.bay!;
        const ring = [
          [-w / 2 - 0.45, 0],
          [w / 2 + 0.45, 0],
          [w / 2, d],
          [-w / 2, d],
        ];
        const shape = new THREE.Shape(
          ring.map(([x, z]) => new THREE.Vector2(x, z)),
        );
        const g = new THREE.ExtrudeGeometry(shape, {
          depth: high - low,
          bevelEnabled: false,
        });
        g.applyMatrix4(
          new THREE.Matrix4().makeBasis(
            wall.tangent,
            wall.normal,
            up.clone().negate(),
          ),
        );
        g.translate(...locate(u, high, 0).toArray());
        const apron = new THREE.Mesh(g, mat(wallColor));
        apron.name = "Continuous chamfered oriel apron";
        apron.castShadow = true;
        apron.receiveShadow = true;
        group.add(apron);
      };
      for (const o of rows) {
        band(o, lower, o.y - o.h / 2);
        lower = o.y + o.h / 2;
      }
      band(rows[rows.length - 1], lower, wall.maxY);
    }
    for (const b of face?.balconies ?? []) {
      if (
        b.u < wall.minU ||
        b.u > wall.maxU ||
        b.y < wall.minY - 0.05 ||
        b.y > wall.maxY + 0.05
      )
        continue;
      const deckY = b.y + (b.surfaceLift ?? 0);
      const chamfer = b.chamfer ?? 0.35,
        d = b.depth,
        w = b.w;
      const outline: Point[] = [
        [-w / 2, 0],
        [w / 2, 0],
        [w / 2, d - chamfer],
        [w / 2 - chamfer, d],
        [-w / 2 + chamfer, d],
        [-w / 2, d - chamfer],
      ];
      const shape = new THREE.Shape(
        outline.map(([u, z]) => new THREE.Vector2(u, z)),
      );
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: 0.2,
        bevelEnabled: false,
      });
      // Shape XY maps to tangent/outward; extrusion maps downwards.
      const basis = new THREE.Matrix4().makeBasis(
        wall.tangent,
        wall.normal,
        up.clone().negate(),
      );
      geometry.applyMatrix4(basis);
      geometry.translate(...locate(b.u, deckY, b.inset ?? 0).toArray());
      const slab = new THREE.Mesh(geometry, mat(wallColor));
      slab.castShadow = true;
      slab.receiveShadow = true;
      slab.name = "Chamfered balcony slab";
      slab.userData.deckHeight = deckY;
      slab.userData.sourceTerraceHeight = b.surfaceLift ? b.y : null;
      group.add(slab);
      if (b.awning) {
        part("#d7d9cd", b.u, deckY - 0.32, w - 0.15, 0.16, 0.3, 0.22);
      }
      if (b.canopyOnly) continue;
      for (let i = 1; i < outline.length; i++) {
        const a = outline[i],
          v = outline[(i + 1) % outline.length];

        const pa = locate(b.u + a[0], deckY, a[1] + (b.inset ?? 0)),
          pb = locate(b.u + v[0], deckY, v[1] + (b.inset ?? 0));
        const axis = pb.clone().sub(pa),
          length = axis.length();
        axis.normalize();
        const q = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(
            axis,
            up,
            new THREE.Vector3().crossVectors(axis, up),
          ),
        );
        const mid = pa.clone().add(pb).multiplyScalar(0.5);
        batch(b.solid ? wallColor : (b.railingColor ?? "#8a9290")).add(
          mid.clone().addScaledVector(up, b.solid ? 0.53 : 1.03),
          new THREE.Vector3(
            length,
            b.solid ? 1.06 : 0.045,
            b.solid ? 0.14 : 0.045,
          ),
          q,
        );
        batch(b.railingColor ?? "#a3aaa7").add(
          mid.clone().addScaledVector(up, 1.08),
          new THREE.Vector3(length, 0.055, 0.18),
          q,
        );
        if (!b.solid) {
          const outward = new THREE.Vector3().crossVectors(axis, up).normalize();
          for (let t = 0; t <= length; t += 0.14) {
            const base = pa.clone().addScaledVector(axis, t);
            if (b.bowedRails) {
              // Segmented metal balusters bow out below the handrail.
              const railPoint = (fraction: number) => base.clone()
                .addScaledVector(up, fraction * 1.06)
                .addScaledVector(outward, Math.sin(Math.PI * fraction) * (1 - fraction) * 0.34);
              for (let segment = 0; segment < 8; segment++) {
                const start = railPoint(segment / 8), end = railPoint((segment + 1) / 8);
                const delta = end.clone().sub(start);
                batch(b.railingColor ?? "#9ca4a2").add(
                  start.add(end).multiplyScalar(0.5),
                  new THREE.Vector3(0.022, delta.length() + 0.004, 0.022),
                  new THREE.Quaternion().setFromUnitVectors(up, delta.normalize()),
                );
              }
            } else {
              batch(b.railingColor ?? "#9ca4a2").add(
                base.addScaledVector(up, 0.53),
                new THREE.Vector3(0.025, 1.06, 0.025), q,
              );
            }
          }
        }
      }
    }
  }
  for (const [c, b] of batches) {
    stats.architecturalParts += b.items.length;
    const slats = profile.faces.some(f => f.openings.some(o => o.rollerShutter?.color === c));
    b.flush(group, `Reference façade parts ${c}`, !slats);
    const rendered = group.children.at(-1);
    if (slats && rendered instanceof THREE.Mesh) rendered.receiveShadow = false;
  }
  for (const m of materials.values()) m.dispose();
  mesh.add(group);
  return group;
}
function decorateBuilding(
  mesh: THREE.Mesh,
  stats: ReconstructionStats,
  gothic: boolean,
) {
  const primary = gothic && mesh.userData.role === "primary";
  mesh.geometry.computeBoundingBox();
  const groundY = mesh.geometry.boundingBox!.min.y;
  const parts = new THREE.Group();
  parts.name = "Reconstructed façade details";
  parts.userData.reconstructed = true;
  const frames = new Batch(box, primary ? stone : trim),
    panes = new Batch(box, glass),
    doors = new Batch(box, wood),
    ornaments = new Batch(new THREE.ConeGeometry(0.5, 1, 4), stone);
  let clockAdded = false;
  for (const wall of wallPlanes(mesh)) {
    const width = wall.maxU - wall.minU,
      height = wall.maxY - wall.minY;
    if (width < 2.1 || height < 3) continue;
    const rotation = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(wall.tangent, up, wall.normal),
    );
    const locate = (u: number, y: number, depth: number) =>
      wall.tangent
        .clone()
        .multiplyScalar(u)
        .addScaledVector(wall.normal, wall.offset + depth)
        .setY(y);
    const onWall = (u: number, y: number) => {
      const point = locate(u, y, 0);
      return wall.triangles.some((tri) => {
        const projected = tri
          .getPlane(new THREE.Plane())
          .projectPoint(point, new THREE.Vector3());
        return tri.containsPoint(projected);
      });
    };
    const part = (
      batch: Batch,
      u: number,
      y: number,
      w: number,
      h: number,
      depth: number = 0.22,
      out: number = 0.16,
    ) => batch.add(locate(u, y, out), new THREE.Vector3(w, h, depth), rotation);
    if (
      primary &&
      !clockAdded &&
      wall.normal.z > 0.7 &&
      width > 4 &&
      width < 18 &&
      wall.maxY > 45 &&
      wall.minY < 48
    ) {
      const u = (wall.minU + wall.maxU) / 2,
        y = Math.min(wall.maxY - 2, 48);
      if (onWall(u - 1.3, y - 1.3) && onWall(u + 1.3, y + 1.3)) {
        const dial = new THREE.Mesh(
          new THREE.CircleGeometry(1.2, 40),
          metal.clone(),
        );
        dial.position.copy(locate(u, y, 0.1));
        dial.quaternion.copy(rotation);
        parts.add(dial);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(1.14, 1.3, 40),
          gold.clone(),
        );
        ring.position.copy(locate(u, y, 0.16));
        ring.quaternion.copy(rotation);
        parts.add(ring);
        const hands = new Batch(box, gold);
        for (let i = 0; i < 12; i++) {
          const angle = (i * Math.PI) / 6;
          hands.add(
            locate(u + Math.sin(angle), y + Math.cos(angle), 0.18),
            new THREE.Vector3(0.06, 0.16, 0.05),
            rotation
              .clone()
              .multiply(
                new THREE.Quaternion().setFromAxisAngle(
                  new THREE.Vector3(0, 0, 1),
                  -angle,
                ),
              ),
          );
        }
        hands.add(
          locate(u, y + 0.4, 0.2),
          new THREE.Vector3(0.075, 0.8, 0.05),
          rotation,
        );
        hands.add(
          locate(u + 0.22, y - 0.12, 0.21),
          new THREE.Vector3(0.55, 0.08, 0.05),
          rotation,
        );
        hands.flush(parts, "Reconstructed clock dial and hands");
        clockAdded = true;
      }
    }
    const spacing = primary ? 3.35 : 3.6,
      cols = Math.max(1, Math.floor(width / spacing));
    const storey = primary ? 4.2 : 3.4;
    for (let y = wall.minY + 2.35; y < wall.maxY - 1.2; y += storey)
      for (let col = 0; col < cols; col++) {
        const u = wall.minU + (width * (col + 0.5)) / cols,
          w = Math.min(primary ? 1.35 : 1.4, (width / cols) * 0.52),
          h = primary ? 2.35 : 1.75;
        // Test all four corners against the union of source wall triangles. This
        // keeps additions off roof triangles and outside stepped/gabled walls.
        if (
          ![
            [u - w * 0.65, y - h * 0.6],
            [u + w * 0.65, y - h * 0.6],
            [u - w * 0.65, y + h * 0.75],
            [u + w * 0.65, y + h * 0.75],
          ].every(([u, y]) => onWall(u, y))
        )
          continue;
        stats.windows++;
        const ground = y < groundY + 4;
        part(ground ? doors : panes, u, y, w, h, 0.06, 0.09);
        part(frames, u - w / 2 - 0.09, y, 0.16, h + 0.3);
        part(frames, u + w / 2 + 0.09, y, 0.16, h + 0.3);
        part(frames, u, y - h / 2 - 0.08, w + 0.46, 0.18, 0.42, 0.22);
        part(frames, u, y, w + 0.04, 0.075, 0.13, 0.105);
        part(frames, u, y, 0.075, h, 0.13, 0.105);
        if (primary) {
          // Pointed stone hood moulding, extruded clear of the original shell.
          const rise = 0.55,
            half = w / 2 + 0.16;
          for (const sign of [-1, 1]) {
            const q = rotation
              .clone()
              .multiply(
                new THREE.Quaternion().setFromAxisAngle(
                  new THREE.Vector3(0, 0, 1),
                  sign * Math.atan2(half, rise),
                ),
              );
            frames.add(
              locate(u + (sign * half) / 2, y + h / 2 + rise / 2, 0.2),
              new THREE.Vector3(0.16, Math.hypot(half, rise), 0.24),
              q,
            );
          }
          if (!ground && col % 2 === 0) {
            part(frames, u + w * 0.9, y, 0.17, h + 0.75, 0.32, 0.25);
            ornaments.add(
              locate(u + w * 0.9, y + h / 2 + 0.75, 0.25),
              new THREE.Vector3(0.38, 0.9, 0.38),
              rotation,
            );
          }
        } else part(frames, u, y + h / 2 + 0.08, w + 0.3, 0.16);
      }
    // Continuous cornice segments only where the underlying shell exists.
    for (let y = wall.minY + storey; y < wall.maxY - 0.7; y += storey)
      for (let u = wall.minU + 0.6; u < wall.maxU - 0.6; u += 1.2) {
        if (onWall(u - 0.6, y) && onWall(u + 0.6, y))
          part(
            frames,
            u,
            y,
            1.21,
            primary ? 0.18 : 0.1,
            primary ? 0.35 : 0.22,
            0.13,
          );
      }
  }
  stats.architecturalParts +=
    frames.items.length +
    panes.items.length +
    doors.items.length +
    ornaments.items.length;
  frames.flush(parts, "Stone frames, mullions and cornices");
  panes.flush(parts, "Recessed window panes");
  doors.flush(parts, "Ground-floor doors and shop openings");
  ornaments.flush(parts, "Gothic hood mouldings and pinnacles");
  mesh.add(parts);
  return parts;
}
/** Roof attachments sit on the decoded roof plane, with a physical clearance. */
function referenceRoof(mesh: THREE.Mesh, stats: ReconstructionStats, profile: FacadeProfile) {
  const group = new THREE.Group();
  group.name = "Photo-reference roof fixtures";
  group.userData.reconstructed = true;
  const p = mesh.geometry.getAttribute("position"), index = mesh.geometry.index;
  const triangles: THREE.Triangle[] = [];
  for (let i = 0; i < (index?.count ?? p.count); i += 3) {
    const t = new THREE.Triangle(...[0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, index ? index.getX(i + k) : i + k)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]);
    if (t.getNormal(new THREE.Vector3()).y > 0.2) triangles.push(t);
  }
  const hitRoof = (x: number, z: number) => {
    const ray = new THREE.Ray(new THREE.Vector3(x, 1000, z), new THREE.Vector3(0, -1, 0));
    return triangles.map(t => ({ point: ray.intersectTriangle(t.a, t.b, t.c, false, new THREE.Vector3()), normal: t.getNormal(new THREE.Vector3()) }))
      .filter((h): h is { point: THREE.Vector3; normal: THREE.Vector3 } => h.point != null)
      .sort((a, b) => b.point.y - a.point.y)[0];
  };
  const batches = new Map<string, Batch>();
  const batch = (c: string) => {
    if (!batches.has(c)) batches.set(c, new Batch(box, new THREE.MeshStandardMaterial({ color: c, roughness: c === "#192d40" ? 0.32 : 0.75, metalness: c === "#bac1bd" ? 0.6 : 0.15 })));
    return batches.get(c)!;
  };
  for (const f of profile.roofFixtures ?? []) {
    const hit = hitRoof(f.x, f.z);
    if (!hit) continue;
    const { point: center, normal } = hit;
    const tangent = new THREE.Vector3(normal.z, 0, -normal.x).normalize();
    if (tangent.lengthSq() < 0.5) tangent.set(1, 0, 0);
    const slope = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangent, normal, slope));
    const at = (u: number, v: number, lift: number) => center.clone().addScaledVector(tangent, u).addScaledVector(slope, v).addScaledVector(normal, lift);
    const part = (c: string, u: number, v: number, w: number, h: number, thickness: number, lift: number) => batch(c).add(at(u, v, lift), new THREE.Vector3(w, thickness, h), q);
    if (f.kind === "solar" || f.kind === "rooflight") {
      // Reject a patch that bridges a ridge or extends beyond the source roof.
      const supported = [-1, 1].every(a => [-1, 1].every(b => {
        const corner = at(a * f.w / 2, b * f.h / 2, 0);
        const roof = hitRoof(corner.x, corner.z);
        return roof && Math.abs(roof.point.y - corner.y) < 0.1;
      }));
      if (!supported) continue;
      const cols = f.kind === "solar" ? (f.columns ?? 1) : 1;
      const rows = f.kind === "solar" ? (f.rows ?? 1) : 1;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const w = f.w / cols - 0.025, h = f.h / rows - 0.025;
        const u = -f.w / 2 + f.w * (c + 0.5) / cols;
        const v = -f.h / 2 + f.h * (r + 0.5) / rows;
        part("#bac1bd", u, v, w, h, 0.09, 0.135);
        part(f.kind === "solar" ? "#192d40" : "#66828a", u, v, w - 0.075, h - 0.075, 0.025, 0.192);
        if (f.kind === "solar") {
          for (let j = 1; j < 6; j++) part("#344857", u - w / 2 + w * j / 6, v, 0.009, h - 0.09, 0.005, 0.209);
          for (let j = 1; j < 10; j++) part("#344857", u, v - h / 2 + h * j / 10, w - 0.09, 0.009, 0.005, 0.209);
        } else {
          part("#c8ceca", u, v - h / 2 + 0.075, w, 0.10, 0.07, 0.22);
        }
      }
    } else if (f.kind === "dormer") {
      const outward = new THREE.Vector3(normal.x, 0, normal.z).normalize();
      const pitch = Math.hypot(normal.x, normal.z) / normal.y;
      if (pitch < 0.15) continue;
      const point = (x: number, y: number, back: number) => center.clone().addScaledVector(tangent, x).addScaledVector(up, y).addScaledVector(outward, -back);
      const eave = f.h * 0.72;
      const a = point(-f.w / 2, -0.06, 0), b = point(f.w / 2, -0.06, 0);
      const c = point(-f.w / 2, eave, 0), d = point(f.w / 2, eave, 0), peak = point(0, f.h, 0);
      const rearLeft = point(-f.w / 2, eave, eave / pitch), rearRight = point(f.w / 2, eave, eave / pitch), rearPeak = point(0, f.h, f.h / pitch);
      const surface = (name: string, triangles: THREE.Vector3[][], c: string) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(triangles.flatMap(t => t.flatMap(v => v.toArray())), 3));
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, side: THREE.DoubleSide }));
        m.name = name; m.castShadow = true; m.receiveShadow = true; group.add(m);
      };
      surface("Photo-based gabled dormer cheeks", [[a,b,d],[a,d,c],[c,d,peak],[a,c,rearLeft],[b,rearRight,d]], f.color ?? profile.wallColor);
      surface("Photo-based dormer pitched roof", [[c,peak,rearPeak],[c,rearPeak,rearLeft],[d,rearRight,rearPeak],[d,rearPeak,peak]], profile.roofColor ?? "#565d58");
      const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangent, up, outward));
      const front = (color: string, x: number, y: number, w: number, h: number, depth: number) => batch(color).add(point(x,y,-depth),new THREE.Vector3(w,h,0.04),rotation);
      front("#e4e3d4",0,eave * 0.49,f.w * 0.82,eave * 0.84,0.022);
      front("#253e42",0,eave * 0.49,f.w * 0.71,eave * 0.69,0.047);
      front("#e4e3d4",0,eave * 0.49,0.055,eave * 0.72,0.075);
      front("#78533f",0,0.04,f.w + 0.12,0.09,0.055);
    } else if (f.kind === "chimney") {
      const base = center.y - 0.3;
      batch(f.color ?? "#925e44").add(new THREE.Vector3(f.x, base + f.h / 2, f.z), new THREE.Vector3(f.w, f.h, f.w * 0.8));
      batch("#555951").add(new THREE.Vector3(f.x, base + f.h + 0.055, f.z), new THREE.Vector3(f.w + 0.16, 0.11, f.w * 0.8 + 0.16));
      for (let y = base + 0.1; y < base + f.h; y += 0.10) {
        batch("#b18d70").add(new THREE.Vector3(f.x, y, f.z), new THREE.Vector3(f.w + 0.009, 0.012, f.w * 0.8 + 0.009));
      }
    } else {
      const dish = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: "#d9ded8", roughness: 0.6 }));
      dish.scale.set(f.w / 2, f.h / 2, 0.08);
      dish.position.copy(center).add(new THREE.Vector3(0, 0.6, 0));
      dish.rotation.x = -0.35;
      dish.name = "Satellite dish";
      group.add(dish);
      batch("#8b938d").add(center.clone().add(new THREE.Vector3(0, 0.22, 0)), new THREE.Vector3(0.055, 0.65, 0.055));
      batch("#737c78").add(center.clone().add(new THREE.Vector3(0, 0.4, 0.23)), new THREE.Vector3(0.035, 0.035, 0.48));
    }
    group.userData.fixtureCount = (group.userData.fixtureCount ?? 0) + 1;
  }
  for (const [c, b] of batches) {
    stats.architecturalParts += b.items.length;
    // Millimetre-thin panel grids should not shadow themselves in the area-wide shadow map.
    b.flush(group, `Roof fittings ${c}`, false);
    const rendered = group.children.at(-1);
    if (rendered instanceof THREE.Mesh) rendered.receiveShadow = false;
  }
  mesh.add(group);
  return group;
}

function roofTiles(mesh: THREE.Mesh, stats: ReconstructionStats, roofColor?: string, tiledRoof = false, finish?: "tiles" | "corrugated") {
  const group = new THREE.Group();
  group.name = "Modeled roof tiles";
  group.userData.reconstructed = true;
  // A reference-specified flat roof finish also covers sloped parapet caps;
  // those narrow source triangles must not acquire generic pitched-roof tiles.
  if (roofColor && !tiledRoof) {
    group.name = "Reference roof finish";
    mesh.add(group);
    return group;
  }
  const primary = mesh.userData.role === "primary";
  const du = finish === "corrugated" ? 0.18 : finish === "tiles" ? 0.22 : 0.85;
  const dv = finish ? 0.32 : 0.7;
  const tiles = new Batch(
    box,
    new THREE.MeshStandardMaterial({
      color: roofColor ?? (primary
        ? 0x626e6b
        : [0x8b6654, 0x6f7470, 0x956953][
            (Number(mesh.userData.OBJECTID) || 0) % 3
          ]),
      roughness: 0.94,
    }),
  );
  const g = mesh.geometry,
    p = g.getAttribute("position"),
    index = g.index,
    count = index ? index.count : p.count;
  const planes: { normal: THREE.Vector3; distance: number; triangles: THREE.Triangle[] }[] = [];
  for (let i = 0; i < count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(
        p,
        index ? index.getX(i) : i,
      ),
      b = new THREE.Vector3().fromBufferAttribute(
        p,
        index ? index.getX(i + 1) : i + 1,
      ),
      c = new THREE.Vector3().fromBufferAttribute(
        p,
        index ? index.getX(i + 2) : i + 2,
      );
    const normal = THREE.Triangle.getNormal(a, b, c, new THREE.Vector3());
    if (normal.y < 0.3 || normal.y > 0.98) continue;
    const distance = normal.dot(a), triangle = new THREE.Triangle(a,b,c);
    const plane = finish && planes.find(p => p.normal.dot(normal) > 0.999999 && Math.abs(p.distance - distance) < 0.02);
    if (plane) plane.triangles.push(triangle);
    else planes.push({ normal, distance, triangles: [triangle] });
  }
  for (const plane of planes) {
    const { normal, distance: planeDistance, triangles } = plane;
    const vertices = triangles.flatMap(t => [t.a,t.b,t.c]);
    const tangent = new THREE.Vector3(normal.z, 0, -normal.x).normalize(),
      slope = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(tangent, normal, slope.clone().negate()),
    );
    const us = vertices.map((v) => v.dot(tangent)),
      vs = vertices.map((v) => v.dot(slope));
    const point = (u: number, v: number) =>
      tangent
        .clone()
        .multiplyScalar(u)
        .addScaledVector(slope, v)
        .addScaledVector(normal, planeDistance);
    for (
      let v = Math.ceil(Math.min(...vs) / dv) * dv;
      v < Math.max(...vs);
      v += dv
    )
      for (
        let u = Math.ceil(Math.min(...us) / du) * du;
        u < Math.max(...us);
        u += du
      ) {
        if (
          ![
            [-du * 0.46, -dv * 0.46],
            [du * 0.46, -dv * 0.46],
            [-du * 0.46, dv * 0.46],
            [du * 0.46, dv * 0.46],
          ].every(([x, y]) => triangles.some(triangle => triangle.containsPoint(point(u + x, v + y))))
        )
          continue;
        const shade = 0.9 + 0.14 * Math.abs(Math.sin(u * 37 + v * 11));
        tiles.add(
          point(u, v).addScaledVector(normal, 0.022),
          new THREE.Vector3(finish === "corrugated" ? 0.065 : du * 0.95, 0.045, dv * 0.97),
          q,
          shade,
        );
      }
  }
  stats.roofTiles += tiles.items.length;
  tiles.flush(group, "Individual roof tiles", false);
  mesh.add(group);
  return group;
}
function styleShell(mesh: THREE.Mesh, profile?: FacadeProfile) {
  const oldGeometry = mesh.geometry,
    oldMaterial = mesh.material;
  const geometry = oldGeometry.clone();
  geometry.clearGroups();
  const p = geometry.getAttribute("position"),
    index = geometry.index,
    count = index ? index.count : p.count;
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    n = new THREE.Vector3();
  const walls: number[] = [],
    roofs: number[] = [];
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(p, index ? index.getX(i) : i);
    b.fromBufferAttribute(p, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(p, index ? index.getX(i + 2) : i + 2);
    THREE.Triangle.getNormal(a, b, c, n);
    const target = Math.abs(n.y) > 0.25 ? roofs : walls;
    for (let j = 0; j < 3; j++) target.push(index ? index.getX(i + j) : i + j);
  }
  geometry.setIndex([...walls, ...roofs]);
  geometry.addGroup(0, walls.length, 0);
  geometry.addGroup(walls.length, roofs.length, 1);
  const primary = mesh.userData.role === "primary",
    palette = [0xd2c9b5, 0xd7c6aa, 0xc9c6b9, 0xd8cdbb, 0xbebcad];
  const id = Number(mesh.userData.OBJECTID) || 0;
  const materials = [
    new THREE.MeshStandardMaterial({
      color: primary ? 0xb7ab94 : palette[id % palette.length],
      roughness: 0.92,
      side: THREE.DoubleSide,
    }),
    new THREE.MeshStandardMaterial({
      color: profile?.roofColor ?? (primary ? 0x626e6b : [0x8b6654, 0x6f7470, 0x956953][id % 3]),
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
  ];
  if (profile) materials[0].visible = false;
  return {
    set(enabled: boolean) {
      mesh.geometry = enabled ? geometry : oldGeometry;
      mesh.material = enabled ? materials : oldMaterial;
    },
    dispose() {
      geometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
export async function createAreaReconstruction(
  model: THREE.Group,
  surfacePath = `${import.meta.env.BASE_URL}area/rathaus-surfaces.json`,
) {
  const response = await fetch(surfacePath);
  if (!response.ok) throw Error("Mapped surface data could not be loaded");
  const data = (await response.json()) as SurfaceData;
  const stats: ReconstructionStats = {
    windows: 0,
    architecturalParts: 0,
    pavingStones: 0,
    roofTiles: 0,
    mappedSurfaces: data.surfaces.length,
    trees: 0,
    railwayTracks: 0,
    railSleepers: 0,
    kerbStones: 0,
    streetFurniture: 0,
    facadeReference: data.primaryFacade
      ? {
          notes: data.primaryFacade.notes,
          references: data.primaryFacade.references,
        }
      : undefined,
  };
  const environment = buildGround(data, stats);
  environment.position.copy(model.position);
  const details: THREE.Group[] = [],
    styles: ReturnType<typeof styleShell>[] = [];
  const meshes: THREE.Mesh[] = [];
  model.traverse((child) => {
    if (child instanceof THREE.Mesh && child.userData.role) meshes.push(child);
  });
  for (const mesh of meshes) {
    const profile =
      mesh.userData.role === "primary" &&
      mesh.userData.gml_id === data.primaryFacade?.gmlId
        ? data.primaryFacade
        : data.connectedFacades?.find((p) => p.gmlId === mesh.userData.gml_id) ?? data.neighborFacades?.find((p) => p.gmlId === mesh.userData.gml_id);
    details.push(
      profile
        ? referenceFacade(mesh, stats, profile)
        : decorateBuilding(mesh, stats, data.architectureStyle === "gothic"),
      roofTiles(mesh, stats, profile?.roofColor, profile?.tiledRoof, profile?.roofFinish),
    );
    if (profile?.roofFixtures?.length) details.push(referenceRoof(mesh, stats, profile));
    styles.push(styleShell(mesh, profile));
  }
  const transport = data.lines.filter((l) =>
    ["tram", "rail", "light_rail", "narrow_gauge"].includes(l.tags.railway),
  );
  const focusLines = transport.length
    ? transport
    : data.lines.filter((l) =>
        ["primary", "secondary", "residential", "pedestrian"].includes(
          l.tags.highway,
        ),
      );
  let streetFocus:
    | { target: THREE.Vector3; direction: THREE.Vector3 }
    | undefined;
  let focusDistance = Infinity;
  for (const line of focusLines)
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1],
        b = line.points[i],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz);
      if (length < 0.1) continue;
      const t = THREE.MathUtils.clamp(
        -(a[0] * dx + a[1] * dz) / (length * length),
        0,
        1,
      );
      const x = a[0] + dx * t,
        z = a[1] + dz * t,
        distance = Math.hypot(x, z);
      if (distance < focusDistance) {
        focusDistance = distance;
        const side = x * dz - z * dx >= 0 ? 1 : -1;
        streetFocus = {
          target: new THREE.Vector3(x, heightField(data)(x, z) + 0.25, z).add(
            model.position,
          ),
          direction: new THREE.Vector3(
            (side * dz + dx * 0.7) / length,
            0.95,
            (-side * dx + dz * 0.7) / length,
          ).normalize(),
        };
      }
    }
  // A mapped square is the useful pavement subject in a pedestrian centre.
  // Look down into it from above surrounding roof height, not through a house.
  const squares = data.surfaces.filter(
    (s) => s.tags.place === "square" && s.surface === "paving_stones",
  );
  for (const square of squares) {
    const center = square.ring.reduce(
      (sum, p) =>
        [
          sum[0] + p[0] / square.ring.length,
          sum[1] + p[1] / square.ring.length,
        ] as Point,
      [0, 0] as Point,
    );
    if (!insideSurface(center, square)) continue;
    streetFocus = {
      target: new THREE.Vector3(
        center[0],
        heightField(data)(...center) + 0.25,
        center[1],
      ).add(model.position),
      direction: new THREE.Vector3(0.1, 1.6, 0.7).normalize(),
    };
    break;
  }
  let entranceFocus:
    | { target: THREE.Vector3; direction: THREE.Vector3 }
    | undefined;
  for (const face of data.primaryFacade?.faces ?? [])
    for (const opening of face.openings)
      if (opening.entrance) {
        const normal = new THREE.Vector3(
            face.normal[0],
            0,
            face.normal[1],
          ).normalize(),
          tangent = new THREE.Vector3(normal.z, 0, -normal.x);
        entranceFocus = {
          target: tangent
            .multiplyScalar(opening.u)
            .addScaledVector(normal, face.offset)
            .setY(opening.y)
            .add(model.position),
          direction: normal
            .clone()
            .add(new THREE.Vector3(0, 0.13, 0))
            .normalize(),
        };
      }
  let visible: string | undefined;
  return {
    environment,
    stats,
    facadeDirection: data.primaryFacade?.cameraDirection,
    facadeObjects: meshes.filter((m) => m.userData.gml_id === data.primaryFacade?.gmlId || data.connectedFacades?.some((p) => p.gmlId === m.userData.gml_id)),
    streetFocus,
    entranceFocus,
    setVisible(enabled: boolean, facadeDetails = true) {
      const key = `${enabled}:${facadeDetails}`;
      if (visible === key) return;
      visible = key;
      environment.visible = enabled;
      for (const detail of details) detail.visible = enabled && facadeDetails;
      for (const style of styles) style.set(enabled && facadeDetails);
    },
    dispose() {
      for (const style of styles) style.dispose();
    },
  };
}
