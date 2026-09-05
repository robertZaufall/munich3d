import * as THREE from 'three';

/** Keep the circular ground tied to horizontal geometry, not camera framing. */
export function fitGroundPlate(points: THREE.Vector3[]) {
  if (!points.length) throw new Error('Cannot fit ground to an empty model');
  const center = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  center.y = 0;
  let footprintRadius = 0;
  for (const point of points) {
    footprintRadius = Math.max(footprintRadius, Math.hypot(point.x - center.x, point.z - center.z));
  }
  const margin = THREE.MathUtils.clamp(footprintRadius * 0.04, 0.5, 3);
  return { center, radius: footprintRadius + margin };
}

/** Fit the projected geometry, including perspective foreshortening. */
export function fitAreaCamera(
  points: THREE.Vector3[],
  direction: THREE.Vector3,
  verticalFovDegrees: number,
  aspect: number,
  fill = 0.9,
) {
  if (!points.length) throw new Error('Cannot frame an empty area');
  const forward = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
  const up = new THREE.Vector3().crossVectors(forward, right).normalize();
  const center = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  const projected = points.map((point) => {
    const offset = point.clone().sub(center);
    return [offset.dot(right), offset.dot(up), offset.dot(forward)];
  });
  const tanY = Math.tan(THREE.MathUtils.degToRad(verticalFovDegrees) / 2);
  const tangents = [tanY * aspect * fill, tanY * fill];
  let distance = 1;
  for (const point of projected) distance = Math.max(distance, point[2] + 1);
  // Each point imposes an interval of allowed camera offsets. Solve the
  // smallest distance at which those intervals overlap on both screen axes.
  for (let axis = 0; axis < 2; axis++) {
    const tangent = tangents[axis];
    let lower = -Infinity;
    let upper = Infinity;
    for (const point of projected) {
      lower = Math.max(lower, point[axis] + tangent * point[2]);
      upper = Math.min(upper, point[axis] - tangent * point[2]);
    }
    distance = Math.max(distance, (lower - upper) / (2 * tangent));
  }
  // Center the actual perspective silhouette, including the non-limiting
  // axis. A world-space bounding-box center is not generally screen-centered.
  const offsets = [0, 0];
  for (let axis = 0; axis < 2; axis++) {
    let low = Infinity;
    let high = -Infinity;
    for (const point of projected) {
      low = Math.min(low, point[axis]);
      high = Math.max(high, point[axis]);
    }
    for (let iteration = 0; iteration < 32; iteration++) {
      const offset = (low + high) / 2;
      let min = Infinity;
      let max = -Infinity;
      for (const point of projected) {
        const value = (point[axis] - offset) / (distance - point[2]);
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      if (min + max > 0) low = offset;
      else high = offset;
    }
    offsets[axis] = (low + high) / 2;
  }
  const target = center.addScaledVector(right, offsets[0]).addScaledVector(up, offsets[1]);
  return { target, position: target.clone().addScaledVector(forward, distance), distance };
}
