import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { formatUnits, createPublicClient, http, erc20Abi } from 'viem';
const expectedBank = '0x478769e1177c0773c43a593dccc4ad15f15f1394';
const expectedCollateral = '0xed7993a74dae1e6656b704a424dcd8711aaf4f72';
export function createGeneration() { let generation = 0; return { invalidate: () => ++generation, current: token => token === generation }; }
export async function guardedRequest(wallet, generation, token, params) { const result = await wallet.request(params); if (!generation.current(token)) throw new Error('connection superseded'); return result; }
export function completePools(activePools, rows, block) {
  if (!Array.isArray(activePools) || !Array.isArray(rows)) return false;
  const active = activePools.map(p => p.toLowerCase()); const found = rows.map(r => r.pool.toLowerCase());
  return new Set(active).size === active.length && new Set(found).size === found.length && active.length === found.length && found.every(p => active.includes(p)) && rows.every(r => r.market && r.priceable && r.size !== 0n && r.asOfBlock === block && compatibleMarket(r.market));
}
export function isFresh(snapshot, now) { return !!snapshot && Number.isFinite(snapshot.sourceAgeMs) && Number.isFinite(snapshot.startedAt) && Number.isFinite(now) && now >= snapshot.startedAt && snapshot.sourceAgeMs >= 0 && snapshot.sourceAgeMs + now - snapshot.startedAt <= 30000; }
export function compatibleMarket(m) { return m?.quoteSymbol?.toLowerCase() === 'usdso' && m.quoteDecimals === 18 && Number.isInteger(m.baseDecimals) && m.baseDecimals >= 0 && m.baseDecimals <= 36; }

export async function readAccount(account) {
  const startedAt = performance.now();
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http() });
  const exchange = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql', addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });
  try {
    const markets = await exchange.client.listPerpMarkets();
    const banks = [...new Set(markets.map(m => m.marginBank?.toLowerCase()).filter(Boolean))];
    if (banks.length !== 1 || banks[0] !== expectedBank) throw new Error('Account bank unavailable');
    const bank = banks[0];
    const config = await exchange.client.getPerpSystemConfig(bank);
    if (!config.fullyWired || config.collateralToken.toLowerCase() !== expectedCollateral) throw new Error('Account bank not ready');
    const collateralDecimals = await publicClient.readContract({address: config.collateralToken, abi: erc20Abi, functionName:'decimals'});
    if (collateralDecimals !== 18) throw new Error('Unsupported collateral precision');
    const [margin, analytics] = await Promise.all([exchange.client.getMarginAccount(bank, account), exchange.client.listPerpPositionAnalytics({ marginBank: bank, account })]);
    const names = new Map(markets.map(m => [m.poolAddress.toLowerCase(), m]));
    const rows = analytics.map(a => ({ ...a, market: names.get(a.pool.toLowerCase()) }));
    const analyticsBlock = rows.length ? rows[0].asOfBlock : margin.asOfBlock;
    const complete = completePools(margin.activePerpPools, rows, analyticsBlock);
    const gap = analyticsBlock > margin.asOfBlock ? analyticsBlock - margin.asOfBlock : margin.asOfBlock - analyticsBlock;
    const [head, marginBlock, positionsBlock] = await Promise.all([publicClient.getBlock(), publicClient.getBlock({blockNumber:margin.asOfBlock}), publicClient.getBlock({blockNumber:analyticsBlock})]);
    const oldest = marginBlock.timestamp < positionsBlock.timestamp ? marginBlock.timestamp : positionsBlock.timestamp;
    if (oldest > head.timestamp) throw new Error('Inconsistent block timestamps');
    const headLagMs = Date.now() - Number(head.timestamp) * 1000;
    if (headLagMs < -5000) throw new Error('Local clock differs from chain time');
    const sourceAgeMs = Number(head.timestamp - oldest) * 1000 + Math.max(0,headLagMs);
    return { margin, rows, analyticsBlock, gap, complete, sourceAgeMs, startedAt, headTimestamp:head.timestamp, marginTimestamp:marginBlock.timestamp, positionsTimestamp:positionsBlock.timestamp }; 
  } finally { await exchange.close(); }
}
export function decimal(value, decimals, maximumFractionDigits = 2) {
  const raw = formatUnits(value, decimals);
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  const clipped = fraction.slice(0, maximumFractionDigits).replace(/0+$/, '');
  const sign = negative && (whole !== '0' || clipped !== '') ? '-' : '';
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (clipped ? '.' + clipped : '');
}
export function shockPnl(rows, btc, eth) {
  const moves = { BTC: btc, ETH: eth };
  if (!rows.every(r => compatibleMarket(r.market))) return null;
  if (Object.values(moves).some(v => !Number.isFinite(v) || v < -100 || v > 1000)) return null;
  return rows.reduce((sum, row) => {
    const move = moves[row.market.baseSymbol] ?? 0;
    const bps = BigInt(Math.round(move * 100));
    return sum + (row.size * row.markPrice * bps / (10n ** BigInt(row.market.baseDecimals) * 10000n));
  }, 0n);
}




// This is an illustrative arithmetic comparison, not protocol health.
export function scenarioBuffer(equity, maintenance, pnlChange) {
  const current = equity - maintenance;
  return { current, illustrative: current + pnlChange };
}
export function signedDecimal(value, decimals, places = 2) {
  const text = decimal(value < 0n ? -value : value, decimals, places);
  if (value === 0n) return '0';
  if (text === '0') return value < 0n ? '-<0.01' : '+<0.01';
  return (value < 0n ? '-' : '+') + text;
}



