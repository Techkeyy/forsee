import {formatUnits,parseUnits} from 'viem';

export function gridDefault(symbol,decimals,min,lot) {
  if (!['BTC','ETH'].includes(symbol) || !Number.isInteger(decimals) || decimals<0 || decimals>36 || typeof min!=='bigint' || typeof lot!=='bigint' || min<=0n || lot<=0n) throw Error('Market size rules are unavailable.');
  const size=((min+lot-1n)/lot)*lot;
  const cap=parseUnits(symbol==='BTC'?'0.001':'0.01',decimals);
  return {min:formatUnits(min,decimals),lot:formatUnits(lot,decimals),suggested:size<=cap?formatUnits(size,decimals):null};
}
export function preferredAmount(symbol,suggestion,edits) {
  return Object.hasOwn(edits,symbol) ? edits[symbol] : (suggestion ?? '');
}
