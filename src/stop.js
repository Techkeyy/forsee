// Pure review logic for SDK 0.32.1. This module does not read or write the network.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const MAX_UINT256 = (1n << 256n) - 1n;

export function parsePrice(input, decimals) {
  if (typeof input !== 'string' || input.length > 120 || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const match = UNSIGNED_DECIMAL.exec(input);
  if (!match || (match[2]?.length || 0) > decimals) return null;
  const result = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] || '').padEnd(decimals, '0') || '0');
  return result > 0n && result <= MAX_UINT256 ? result : null;
}

// quantity=0 is the SDK's whole-remaining-position sentinel at trigger time.
export function reviewStopTerms(row, input) {
  const market = row?.market;
  if (!row?.priceable || !market || !['BTC', 'ETH'].includes(market.baseSymbol) || market.quoteDecimals !== 18 || market.quoteSymbol?.toLowerCase() !== 'usdso' || typeof row.size !== 'bigint' || typeof row.markPrice !== 'bigint' || row.size === 0n || row.markPrice <= 0n || !ADDRESS.test(row.pool || '') || !ADDRESS.test(market.stopRegistry || '')) return null;
  const triggerPrice = parsePrice(input, market.quoteDecimals);
  if (triggerPrice === null || (row.size > 0n && triggerPrice >= row.markPrice) || (row.size < 0n && triggerPrice <= row.markPrice)) return null;
  return { registry: market.stopRegistry, pool: row.pool, isBid: row.size < 0n, quantity: 0n, triggerPrice, triggerOperator: row.size > 0n ? 1 : 0, stopOrderType: 1, intent: 'reduceOnly' };
}

// Pending is confirmed by the registry; terminal history is attributed to the indexer.
// An absent registry entry alone cannot tell cancellation from triggering.
export function mapStopState(chainOrder, indexed, owner) {
  if (!ADDRESS.test(owner || '')) return { state: 'unknown', source: 'invalid owner' };
  const belongs = value => typeof value === 'string' && value.toLowerCase() === owner.toLowerCase();
  if (chainOrder) return belongs(chainOrder.owner) ? { state: 'pending', source: 'registry' } : { state: 'unknown', source: 'owner mismatch' };
  if (!indexed || !belongs(indexed.owner)) return { state: 'unknown', source: 'no matching indexed history' };
  if (indexed.status === 'TRIGGERED') return { state: indexed.placedOrderId != null ? 'order placed' : 'triggered', source: 'indexer', orderId: indexed.placedOrderId ?? null };
  if (indexed.status === 'TRIGGER_FAILED') return { state: 'failed or dropped', source: 'indexer', reason: indexed.dropReason ?? null };
  if (indexed.status === 'CANCELLED') return { state: 'cancelled', source: 'indexer' };
  return { state: 'unknown', source: 'registry and indexer disagree' };
}

export function validStopReference(registry, orderId) {
  if (!ADDRESS.test(registry || '') || typeof orderId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(orderId)) return false;
  return BigInt(orderId) < (1n << 128n);
}


// Require exactly one currently discovered BTC/ETH pool with the same registry.
export function matchesDiscoveredMarket(row, markets) {
  const pool = row?.pool;
  const registry = row?.market?.stopRegistry;
  const symbol = row?.market?.baseSymbol;
  if (!ADDRESS.test(pool || '') || !ADDRESS.test(registry || '') || !['BTC','ETH'].includes(symbol) || !Array.isArray(markets)) return false;
  const matches = markets.filter(m => typeof m.poolAddress === 'string' && m.poolAddress.toLowerCase() === pool.toLowerCase());
  return matches.length === 1 && matches[0].baseSymbol === symbol && typeof matches[0].stopRegistry === 'string' && matches[0].stopRegistry.toLowerCase() === registry.toLowerCase();
}
