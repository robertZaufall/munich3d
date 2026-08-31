const metres = (value, digits = 2) => `${Number(value).toFixed(digits)} m`;

export function createCatalogEntry({
  id,
  metadata,
  modelPath,
  sourceMeshPath,
  metadataPath,
  runtime = false,
}) {
  const primary = metadata.buildings?.find(
    (building) => building.role === 'primary',
  );
  if (!primary) throw new Error(`Model bundle "${id}" has no primary building`);

  const buildingCount = metadata.buildings.length;
  const neighborCount = metadata.buildings.filter(
    (building) => building.role === 'neighbor',
  ).length;
  if (
    metadata.selection?.buildingCount !== buildingCount ||
    metadata.selection?.neighborCount !== neighborCount
  ) {
    throw new Error(`Model bundle "${id}" has inconsistent feature counts`);
  }

  const matchedAddress = metadata.geocode?.matchedAddress ?? metadata.request?.address;
  const location = metadata.geocode?.location ?? metadata.selection?.locationWgs84;
  const bounds = primary.boundsEpsg3857;
  const scale =
    metadata.objTransformation?.horizontalScaleFromWebMercatorToLocalMetres;
  if (!matchedAddress || !location || !bounds || !Number.isFinite(scale)) {
    throw new Error(`Model bundle "${id}" lacks catalog metadata`);
  }

  const addressParts = matchedAddress.split(',').map((part) => part.trim());
  const streetAddress = addressParts[0];
  const locality = addressParts.slice(1, 4).filter(Boolean).join(' · ');
  const sourceName = primary.attributes?.gml_name?.split(',')[0]?.trim();
  const address = sourceName || streetAddress;
  const district = sourceName
    ? [streetAddress, locality].filter(Boolean).join(' · ')
    : locality;
  const width = (bounds.maximum[0] - bounds.minimum[0]) * scale;
  const depth = (bounds.maximum[1] - bounds.minimum[1]) * scale;
  const ground = Number(primary.attributes?.HoeheGrund);
  const roof = Number(primary.attributes?.HoeheDach);
  const measuredHeight = Number(primary.attributes?.citygml_measured_height);
  const height = Number.isFinite(measuredHeight)
    ? measuredHeight
    : roof - ground;
  const itemId = metadata.source?.itemId;
  const sourceUrl = itemId
    ? `https://hub.arcgis.com/maps/${itemId}/explore?location=${location.latitude.toFixed(6)}%2C${location.longitude.toFixed(6)}%2C19`
    : metadata.source?.sceneServiceUrl;
  const neighborDistance = Number(metadata.request?.neighborDistanceMetres ?? 35);

  return {
    id,
    runtime,
    switchLabel: runtime ? `${address} · ${neighborDistance} m` : address,
    address,
    district,
    modelPath,
    sourceMeshPath,
    metadataPath,
    sourceUrl,
    objectId: String(primary.attributes?.OBJECTID ?? primary.featureId),
    gmlId: primary.attributes?.gml_id ?? '',
    width: metres(width),
    depth: metres(depth),
    height: metres(height),
    storeys: String(primary.attributes?.citygml_storeys_above_ground ?? '—'),
    ground: Number.isFinite(ground) ? metres(ground, 3) : '—',
    roof: Number.isFinite(roof) ? metres(roof, 3) : '—',
    buildingCount,
    neighborCount,
    neighborDistance,
    neighborSelectionMode:
      metadata.selection?.neighborSelectionMode ?? 'closest_geometry_from_primary',
    primaryTriangleCount: Number(primary.triangleCount ?? 0),
    triangleCount: metadata.buildings.reduce(
      (total, building) => total + Number(building.triangleCount ?? 0),
      0,
    ),
  };
}
