export function getOdooRelationId(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function buildLocationIndex(locations) {
  const index = new Map();
  (locations || []).forEach((location) => {
    if (location?.id != null) index.set(location.id, location);
  });
  return index;
}

export function buildWarehouseLocationMaps(warehouses) {
  const lotStockWarehouseNameByLocationId = new Map();
  const viewWarehouseNameByLocationId = new Map();

  (warehouses || []).forEach((warehouse) => {
    const warehouseName = String(warehouse?.name || '').trim();
    const lotStockId = getOdooRelationId(warehouse?.lot_stock_id);
    const viewLocationId = getOdooRelationId(warehouse?.view_location_id);

    if (lotStockId) lotStockWarehouseNameByLocationId.set(lotStockId, warehouseName);
    if (viewLocationId) viewWarehouseNameByLocationId.set(viewLocationId, warehouseName);
  });

  return { lotStockWarehouseNameByLocationId, viewWarehouseNameByLocationId };
}

export function resolveWarehouseNameForLocation(location, { locationById, lotStockWarehouseNameByLocationId, viewWarehouseNameByLocationId }) {
  if (!location) return null;

  const directWarehouseName = lotStockWarehouseNameByLocationId.get(location.id);
  if (directWarehouseName) return directWarehouseName;

  const visited = new Set();
  let current = location;

  for (let i = 0; i < 20 && current && !visited.has(current.id); i += 1) {
    visited.add(current.id);

    if (lotStockWarehouseNameByLocationId.has(current.id)) {
      return lotStockWarehouseNameByLocationId.get(current.id);
    }
    if (viewWarehouseNameByLocationId.has(current.id)) {
      return viewWarehouseNameByLocationId.get(current.id);
    }

    const parentId = getOdooRelationId(current.location_id);
    if (!parentId) break;
    current = locationById.get(parentId);
  }

  return null;
}

export function getLocationDisplayLabel(location, maps) {
  if (!location) return '';

  const warehouseName = resolveWarehouseNameForLocation(location, maps);
  const rawName = String(location.name || location.complete_name || '').trim();
  const isWarehouseStockLocation = maps.lotStockWarehouseNameByLocationId.has(location.id);

  if (warehouseName && isWarehouseStockLocation) return warehouseName;
  if (warehouseName) return `${warehouseName} · ${rawName || String(location.id)}`;
  return rawName || String(location.id || '');
}
