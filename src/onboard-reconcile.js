import {decodeEventLog, parseAbi} from 'viem';

export function assertAttempt(generation, attempt) {
  if (generation.current !== attempt) throw Error('Wallet connection changed. Reconnect before continuing.');
}
export function bufferedGas(estimateHex, priceHex, balanceHex) {
  const estimate=BigInt(estimateHex), gasPrice=BigInt(priceHex), balance=BigInt(balanceHex);
  if (estimate <= 0n || gasPrice <= 0n) throw Error('Gas could not be estimated. Try again later.');
  const gasLimit=(estimate*3n+1n)/2n;
  if (balance < gasLimit*gasPrice) throw Error('Your wallet does not have enough STT for the estimated gas.');
  return gasLimit;
}
export function saveVerified(storage, key, value) {
  const encoded = JSON.stringify(value);
  storage.setItem(key,encoded);
  if (storage.getItem(key) !== encoded) throw Error('Could not save transaction recovery information.');
  return encoded;
}
export function persistHash(primary, fallback, key, record) {
  try { saveVerified(primary,key,record); return 'primary'; }
  catch { saveVerified(fallback,`${key}:hash-backup`,record); return 'fallback'; }
}
export function definiteRejection(error) {
  return error?.code === 4001 && !error.cause && !error.data && !error.error && !error.originalError && !error.transactionHash && !error.hash && !/0x[0-9a-fA-F]{64}/.test(String(error.message || ''));
}
export function removeMatching(storage,key,expected) {
  const current=storage.getItem(key);
  if (current !== JSON.stringify(expected)) throw Error('The saved request changed. Check it again.');
  storage.removeItem(key);
}
export async function withWalletLock(manager, key, action) {
  if (!manager?.request) throw Error('This browser cannot safely coordinate wallet requests across tabs.');
  return manager.request(key,{mode:'exclusive',ifAvailable:true},async lock => {
    if (!lock) throw Error('Another tab is already preparing a request for this wallet.');
    return action();
  });
}

// Mirrors orderBookEventsAbi in the pinned markets SDK 0.32.1.
export const eventAbi = parseAbi([
  'event OrderPlaced(uint128 indexed orderId, (uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs) placedOrder)',
  'event OrderFilled(uint128 indexed takerOrderId, uint128 indexed makerOrderId, uint256 quantityFilled, uint256 takerRemainingQuantity, uint256 makerRemainingQuantity, uint256 fillPrice)',
  'event OrderRested(uint128 indexed orderId)'
]);

export function receiptOrder(receipt, intent, account) {
  const events = (receipt.logs || []).filter(log => log.address?.toLowerCase() === intent.pool.toLowerCase()).flatMap(log => {
    try { return [decodeEventLog({abi:eventAbi, data:log.data, topics:log.topics, strict:true})]; } catch { return []; }
  });
  const placed = events.filter(e => e.eventName === 'OrderPlaced' && e.args.placedOrder.owner.toLowerCase() === account.toLowerCase() && e.args.placedOrder.isBid && e.args.placedOrder.price === BigInt(intent.price) && e.args.placedOrder.fullQuantity === BigInt(intent.quantity) && e.args.orderId === e.args.placedOrder.orderId);
  if (placed.length !== 1) return null;
  const id = placed[0].args.orderId;
  if (events.some(e => e.eventName === 'OrderRested' && e.args.orderId === id)) return null;
  const fills = events.filter(e => e.eventName === 'OrderFilled' && e.args.takerOrderId === id);
  const total = fills.reduce((sum,e) => sum + e.args.quantityFilled, 0n);
  if (!fills.length || total <= 0n || total > BigInt(intent.quantity)) return null;
  return {orderId:String(id),filled:String(total),requested:intent.quantity};
}
