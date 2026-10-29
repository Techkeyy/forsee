import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, erc20Abi } from 'viem';
const rpc = hidekiTestnet.rpcUrls.default.http[0];
const call = async (method, params=[]) => { const res = await fetch(rpc, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}), signal:AbortSignal.timeout(15000) }); const j=await res.json(); if(j.error) throw new Error(j.error.message); return j.result; };
const out = (name, value) => console.log(name, JSON.stringify(value, (_,v)=>typeof v==='bigint'?v.toString():v));
const expectEqual = (name, actual, expected) => { if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw new Error(name + ' mismatch: ' + actual); };
let exchange;
try {
  out('checkedAt',new Date().toISOString()); out('rpc',rpc);
  const chainId=await call('eth_chainId'), networkId=await call('net_version'), genesisHash=(await call('eth_getBlockByNumber',['0x0',false])).hash;
  out('chainId',chainId); out('networkId',networkId); out('genesisHash',genesisHash);
  expectEqual('chainId',chainId,process.argv.includes('--test-mismatch') ? '0x0' : '0xc4cf'); expectEqual('networkId',networkId,'50000259'); expectEqual('genesisHash',genesisHash,'0x555de6145260a388241bea0f9328d57335d330d5a0fbb329de1a4fd1c7f2eb25');
  exchange = new SomniaMarkets({chain:hidekiTestnet,indexerUrl:'https://hideki-dev.smk.somnia.host/v1/graphql',addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES});
  const markets=await exchange.client.listPerpMarkets();
  out('markets',markets.map(m=>({baseSymbol:m.baseSymbol,quoteSymbol:m.quoteSymbol,poolAddress:m.poolAddress,marginBank:m.marginBank,baseDecimals:m.baseDecimals,quoteDecimals:m.quoteDecimals})));
  const banks=[...new Set(markets.map(m=>m.marginBank?.toLowerCase()).filter(Boolean))];
  out('uniqueBanks',banks);
  if (banks.length !== 1) throw new Error('Unexpected number of margin banks');
  expectEqual('margin bank', banks[0], '0x478769e1177c0773c43a593dccc4ad15f15f1394');
  const config=await exchange.client.getPerpSystemConfig(banks[0]); out('systemConfig',config);
  if (config.fullyWired !== true) throw new Error('System not fully wired');
  for (const [key,expected] of Object.entries({collateralToken:'0xed7993a74dae1e6656b704a424dcd8711aaf4f72',perpPoolFactory:'0xe631faee547baee07353e290f0562ea67d856560',liquidationEngine:'0xa66d3c24ad4a389d863846905d8173e1017e9f4d',insuranceFund:'0x50826894d47c6d4f3bea38bfdc7dc5c5be171b80'})) expectEqual(key,config[key],expected);
  const client = createPublicClient({ chain: hidekiTestnet, transport: http() });
  const decimals = await client.readContract({address:config.collateralToken,abi:erc20Abi,functionName:'decimals'}); out('collateralDecimals',decimals);
  if (decimals !== 18) throw new Error('Unsupported collateral precision');
  if (markets.some(m=>m.quoteSymbol?.toLowerCase() !== 'usdso' || m.quoteDecimals !== 18)) throw new Error('Unsupported market quote unit');
  if (!markets.some(m=>m.baseSymbol==='BTC') || !markets.some(m=>m.baseSymbol==='ETH') || banks.length!==1) throw new Error('Expected BTC and ETH markets sharing one bank were not confirmed');
  console.log('PASS: market discovery and system config; account and trading paths were not tested.');
} catch(e) { console.error('FAIL:',e?.stack || e); process.exitCode=1; } finally { await exchange?.close(); }


