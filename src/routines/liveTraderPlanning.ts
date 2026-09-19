import { mapStore } from "../mapstore.js";
import { maxItemsForCargo } from "./common.js";

export interface LiveTradeSettings {
  minProfitPerUnit: number;
  maxCargoValue: number;
  fuelCostPerJump: number;
  freeCargoWeight: number;
  homeSystem: string;
  homeStation: string;
}

export interface LiveTradeCandidate {
  itemId: string;
  itemName: string;
  sourceSnapshot: import("../marketSnapshotStore.js").MarketStationSnapshot;
  destSnapshot: import("../marketSnapshotStore.js").MarketStationSnapshot;
  sourceOrder: import("../marketSnapshotStore.js").MarketBookOrder;
  destOrder: import("../marketSnapshotStore.js").MarketBookOrder;
  quantity: number;
  sourcePrice: number;
  destinationPrice: number;
  spreadPerUnit: number;
  grossProfit: number;
  fuelCost: number;
  totalProfit: number;
  profitPerUnit: number;
  jumps: number;
  routeSystemIds: string[];
  sourceOrderId?: string;
  destOrderId?: string;
  routeClaimKey: string;
}

function orderIdentity(order: import("../marketSnapshotStore.js").MarketBookOrder): string | undefined {
  return order.orderId || order.source || undefined;
}

function sameStation(a: import("../marketSnapshotStore.js").MarketStationSnapshot, b: import("../marketSnapshotStore.js").MarketStationSnapshot): boolean {
  return a.systemId.toLowerCase() === b.systemId.toLowerCase() && a.poiId.toLowerCase() === b.poiId.toLowerCase();
}

function routeClaimKey(candidate: Omit<LiveTradeCandidate, "routeClaimKey">): string {
  return [
    candidate.itemId,
    candidate.sourceSnapshot.systemId.toLowerCase(),
    candidate.sourceSnapshot.poiId.toLowerCase(),
    candidate.destSnapshot.systemId.toLowerCase(),
    candidate.destSnapshot.poiId.toLowerCase(),
  ].join("|");
}

export function planLiveTradeRoutes(snapshots: import("../marketSnapshotStore.js").MarketStationSnapshot[], settings: LiveTradeSettings): LiveTradeCandidate[] {
  const byItem = new Map<string, import("../marketSnapshotStore.js").MarketBookItem[]>();
  for (const snapshot of snapshots) {
    for (const item of snapshot.items) {
      const orders = byItem.get(item.itemId) || [];
      orders.push(item);
      byItem.set(item.itemId, orders);
    }
  }

  const candidates: LiveTradeCandidate[] = [];
  for (let sourceIndex = 0; sourceIndex < snapshots.length; sourceIndex++) {
    const source = snapshots[sourceIndex];
    if (!source.systemId || !source.poiId) continue;
    for (let destIndex = 0; destIndex < snapshots.length; destIndex++) {
      const dest = snapshots[destIndex];
      if (!dest.systemId || !dest.poiId || sameStation(source, dest)) continue;

      const sourceItems = source.items;
      const destItems = dest.items;
      if (!sourceItems || !destItems) continue;

      for (const sourceItem of sourceItems) {
        const sourceOrders = [...sourceItem.sellOrders].sort((a, b) => a.price - b.price);
        const destItem = destItems.find((item) => item.itemId === sourceItem.itemId);
        if (!destItem) continue;
        const destOrders = [...destItem.buyOrders].sort((a, b) => b.price - a.price);

        for (const sourceOrder of sourceOrders) {
          for (const destOrder of destOrders) {
            const jumps = Math.max(0, (mapStore.findRoute(source.systemId, dest.systemId) || [source.systemId, dest.systemId]).length - 1);
            const cargoLimit = maxItemsForCargo(settings.freeCargoWeight, sourceItem.itemId);
            const valueLimit = settings.maxCargoValue > 0 ? Math.floor(settings.maxCargoValue / sourceOrder.price) : Number.POSITIVE_INFINITY;
            const quantity = Math.max(0, Math.floor(Math.min(sourceOrder.quantity, destOrder.quantity, cargoLimit, valueLimit)));
            if (quantity <= 0) continue;

            const sourcePrice = sourceOrder.price;
            const destinationPrice = destOrder.price;
            const spreadPerUnit = destinationPrice - sourcePrice;
            const grossProfit = spreadPerUnit * quantity;
            const fuelCost = jumps * settings.fuelCostPerJump;
            const totalProfit = grossProfit - fuelCost;
            const profitPerUnit = quantity > 0 ? totalProfit / quantity : 0;
            if (profitPerUnit < settings.minProfitPerUnit || totalProfit <= 0) continue;

            const baseCandidate = {
              itemId: sourceItem.itemId,
              itemName: sourceItem.itemName || sourceItem.itemId,
              sourceSnapshot: source,
              destSnapshot: dest,
              sourceOrder,
              destOrder,
              quantity,
              sourcePrice,
              destinationPrice,
              spreadPerUnit,
              grossProfit,
              fuelCost,
              totalProfit,
              profitPerUnit,
              jumps,
              routeSystemIds: mapStore.findRoute(source.systemId, dest.systemId) || [source.systemId, dest.systemId],
              sourceOrderId: orderIdentity(sourceOrder),
              destOrderId: orderIdentity(destOrder),
            };
            candidates.push({ ...baseCandidate, routeClaimKey: routeClaimKey(baseCandidate) });
          }
        }
      }
    }
  }

  return candidates.sort((a, b) => b.totalProfit - a.totalProfit || b.spreadPerUnit - a.spreadPerUnit || a.itemId.localeCompare(b.itemId));
}
