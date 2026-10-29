import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeFunctionData,decodeFunctionData,parseAbi } from 'viem';
import {matchesStopCall} from '../src/stop-attempt.js';
const require=createRequire(import.meta.url);
// SDK 0.32.1 does not publicly export its perp stop ABI; resolve the pinned package's installed file for this regression test.
const sdkAbi=await import(pathToFileURL(join(dirname(require.resolve('@somnia-chain/markets-sdk')),'tradeAbi.js')).href);
const localAbi=parseAbi(['function createPendingOrder(((bool isBid, address owner, uint64 userData, uint256 quantity) order, uint8 orderType, uint256 triggerPrice, uint8 triggerOperator, uint256 limitPrice, address builder, uint96 builderFeeBpsTimes1k) orderWithTrigger) payable returns (uint128 pendingOrderId)']);
test('pinned SDK calldata decodes to the exact reduce-only stop terms',()=>{
 const owner='0x1111111111111111111111111111111111111111';
 const record={account:owner,side:'long',trigger:'100'};
 const leg={order:{isBid:false,owner,userData:0n,quantity:0n},orderType:1,triggerPrice:100n,triggerOperator:1,limitPrice:0n,builder:'0x0000000000000000000000000000000000000000',builderFeeBpsTimes1k:0n};
 const data=encodeFunctionData({abi:sdkAbi.perpStopRegistryWriteAbi,functionName:'createPendingOrder',args:[leg]});
 const decoded=decodeFunctionData({abi:localAbi,data});
 assert.equal(matchesStopCall(record,decoded),true);
 assert.equal(matchesStopCall({...record,trigger:'101'},decoded),false);
});
