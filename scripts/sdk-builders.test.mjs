import assert from 'node:assert/strict';
import {SomniaMarkets,SOMNIA_HIDEKI_TESTNET_ADDRESSES,PLACE_ORDER_FOR_SELECTOR} from '@somnia-chain/markets-sdk';
import {hidekiTestnet} from '@somnia-chain/markets-sdk/chains';
import {createWalletClient,custom,decodeFunctionData,parseAbi} from 'viem';
const account='0x'+'12'.repeat(20),registry='0x'+'34'.repeat(20),pool='0x'+'56'.repeat(20),operatorRegistry='0x'+'78'.repeat(20);
const provider={request:async()=>{throw Error('Network access prohibited during builder test');}};
const ex=new SomniaMarkets({chain:hidekiTestnet,indexerUrl:'https://invalid.example/graphql',addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES});ex.setSigner({walletClient:createWalletClient({account,chain:hidekiTestnet,transport:custom(provider)}),account});
try{
 const built=await ex.trader.buildPlacePerpStopOrder({registry,pool,isBid:false,quantity:0n,triggerPrice:100n,triggerOperator:1,stopOrderType:1,intent:'reduceOnly',operatorRegistry,somiPayment:5n});
 assert.equal(built.stopOrder.chainId,50383);assert.equal(built.stopOrder.to.toLowerCase(),registry);assert.equal(built.stopOrder.value,5n);assert.equal(built.operatorApproval.to.toLowerCase(),operatorRegistry);assert.equal(built.operatorApproval.value,0n);
 const approve=decodeFunctionData({abi:parseAbi(['function setOperatorApprovalGlobal(address operator,bytes4[] selectors,bool approved)']),data:built.operatorApproval.data});assert.equal(approve.args[0].toLowerCase(),registry);assert.equal(approve.args[1][0],PLACE_ORDER_FOR_SELECTOR);assert.equal(approve.args[2],true);
 const cancel=ex.trader.buildCancelPerpStopOrder({registry,orderId:'42'});assert.equal(cancel.chainId,50383);assert.equal(cancel.to.toLowerCase(),registry);assert.equal(cancel.value,0n);const decoded=decodeFunctionData({abi:parseAbi(['function cancelPendingOrder(uint128 orderId)']),data:cancel.data});assert.equal(decoded.args[0],42n);
 console.log('SDK unsigned builder checks passed');
}finally{ex.setSigner({});await ex.close();}
