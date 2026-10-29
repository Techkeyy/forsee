import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, PLACE_ORDER_FOR_SELECTOR } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, isAddress, parseAbi } from 'viem';

const exchange=()=>new SomniaMarkets({chain:hidekiTestnet,indexerUrl:'https://hideki-dev.smk.somnia.host/v1/graphql',addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES});
const permissionAbi=parseAbi(['function isGloballyApproved(address owner, address operator, bytes4 selector) view returns (bool)']);
export function supportedRegistries(markets) {
  if(!Array.isArray(markets)) return [];
  return markets.filter(m=>['BTC','ETH'].includes(m.baseSymbol) && isAddress(m.poolAddress || '') && isAddress(m.stopRegistry || ''));
}
export async function discoverPermissionMarkets() {
  const ex=exchange();try{return supportedRegistries(await ex.client.listPerpMarkets());}finally{await ex.close();}
}
export async function readGlobalPermission(account, selected) {
  if(!isAddress(account)) throw new Error('Invalid account');
  const ex=exchange();
  try {
    const markets=supportedRegistries(await ex.client.listPerpMarkets());
    const exact=markets.filter(m=>m.poolAddress.toLowerCase()===selected.poolAddress.toLowerCase() && m.stopRegistry.toLowerCase()===selected.stopRegistry.toLowerCase() && m.baseSymbol===selected.baseSymbol);
    if(exact.length!==1) throw new Error('Registry is not verified');
    const m=exact[0];
    const [binding,indexed] = await Promise.allSettled([
      ex.client.getOperatorPermissionsRegistry(m.poolAddress),
      ex.client.listPerpStopOrders({account,pool:m.poolAddress,status:['PENDING'],limit:100})
    ]);
    const permissionRegistry=binding.status==='fulfilled'?binding.value:null;
    let global=null;
    if(permissionRegistry) {
      try {
        global=await createPublicClient({chain:hidekiTestnet,transport:http()}).readContract({address:permissionRegistry,abi:permissionAbi,functionName:'isGloballyApproved',args:[account,m.stopRegistry,PLACE_ORDER_FOR_SELECTOR]});
      } catch { /* Unknown is safer than treating a failed read as an absent grant. */ }
    }
    return {market:m,permissionRegistry,bindingStatus:binding.status==='rejected'?'unavailable':permissionRegistry?'wired':'unwired',global,pending:indexed.status==='fulfilled'?indexed.value:null,readAt:Date.now()};
  } finally {await ex.close();}
}
