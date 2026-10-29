import {decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi, parseUnits} from 'viem';

export const actionLockKey = account => `forsee:action:50383:${account.toLowerCase()}`;
export function exactUnits(value,decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || (value.split('.')[1]?.length || 0)>decimals) throw Error('Enter an exact amount within the market precision.');
  return parseUnits(value,decimals);
}
export function boundedLong({ask,tick,quantity,lot,min,baseDecimals,quoteDecimals,symbol}) {
  if (!['BTC','ETH'].includes(symbol) || quoteDecimals!==18 || !Number.isInteger(baseDecimals) || baseDecimals<0 || baseDecimals>36 || [ask,tick,quantity,lot,min].some(x=>typeof x!=='bigint' || x<=0n)) throw Error('Market data is unavailable.');
  if (quantity%lot || quantity<min || quantity>exactUnits(symbol==='BTC'?'0.001':'0.01',baseDecimals)) throw Error('Amount is outside the supported range or market lot size.');
  const price=(ask*101n/100n/tick)*tick;
  if (price<ask || price<=0n) throw Error('No acceptable price is available within 1% of the ask.');
  if (price*quantity > 100n * 10n**BigInt(quoteDecimals) * 10n**BigInt(baseDecimals)) throw Error('Order value exceeds 100 USDso.');
  return price;
}
export function validateFunding(margin,approvedAllowance) {
  if (!margin?.priceable || !margin.sufficient || !margin.wallet || margin.fundingPayer !== null || margin.mainWalletPull!==0n || margin.mainFundingBlocked) throw Error('Funding could not be verified for this order. Linked funding accounts are not supported.');
  if (margin.wallet.allowance>20n*10n**18n) throw Error('Limit your MarginBank token allowance to 20 USDso or less before trading.');
  if (approvedAllowance !== undefined && margin.wallet.allowance>approvedAllowance) throw Error('Wallet spending permission changed. Refresh the quote.');
}

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
export function beforeWalletRequest(signal,generation,attempt,storage,key,intent) {
  try {
    assertAttempt(generation,attempt);
    if (!signal || signal.aborted) throw Error('Session disconnected before the wallet request.');
  } catch(e) { removeMatching(storage,key,intent); throw e; }
}
export function validApprovalIntent(intent,token,spender,amount) {
  try { return intent?.kind===(amount===0n?'revoke':'approval') && intent.to?.toLowerCase()===token.toLowerCase() && intent.spender?.toLowerCase()===spender.toLowerCase() && intent.approvalAmount===String(amount) && intent.data?.toLowerCase()===encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[spender,amount]}).toLowerCase() && BigInt(intent.value)===0n; } catch { return false; }
}
const perpOrderAbi=parseAbi(['function placeOrder(bool isBid,uint64 userData,uint256 price,uint256 quantity,uint64 expireTimestampNs,uint8 orderType,uint8 selfMatchingOption,address builder,uint96 builderFeeBpsTimes1k)']);
export function revertedOrderReceipt(tx,receipt,intent,account) {
  try {
    const eq=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
    if (intent.kind!=='order' || receipt.status!=='0x0' || !eq(tx.hash,intent.hash) || !eq(receipt.transactionHash,intent.hash) || !eq(tx.from,account) || !eq(receipt.from,account) || !eq(tx.to,intent.pool) || !eq(receipt.to,intent.pool) || !eq(tx.input,intent.data) || !eq(tx.blockHash,receipt.blockHash) || !/^0x[0-9a-f]{64}$/i.test(tx.blockHash || '') || BigInt(tx.chainId)!==50383n || BigInt(tx.value)!==0n) return false;
    const decoded=decodeFunctionData({abi:perpOrderAbi,data:tx.input}); const a=decoded.args;
    return decoded.functionName==='placeOrder' && a[0]===true && a[1]===0n && a[2]===BigInt(intent.price) && a[3]===BigInt(intent.quantity) && a[5]===2 && a[6]===0 && eq(a[7],'0x0000000000000000000000000000000000000000') && a[8]===0n;
  } catch { return false; }
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
  let remaining=BigInt(intent.quantity);
  for (const fill of fills) {
    if (fill.args.quantityFilled<=0n || fill.args.quantityFilled>remaining || fill.args.fillPrice<=0n || fill.args.fillPrice>BigInt(intent.price)) return null;
    remaining-=fill.args.quantityFilled;
    if (fill.args.takerRemainingQuantity!==remaining) return null;
  }
  if (!fills.length || total <= 0n || total > BigInt(intent.quantity)) return null;
  return {orderId:String(id),filled:String(total),requested:intent.quantity};
}
