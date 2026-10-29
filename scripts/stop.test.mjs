import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, reviewStopTerms, mapStopState, validStopReference, matchesDiscoveredMarket } from '../src/stop.js';
const owner='0x1111111111111111111111111111111111111111', pool='0x2222222222222222222222222222222222222222', registry='0x3333333333333333333333333333333333333333';
const row = size => ({pool,size,markPrice:100n*10n**18n,priceable:true,market:{baseSymbol:'BTC',quoteSymbol:'USDso',quoteDecimals:18,stopRegistry:registry}});
test('protective stops use exact units and direction', () => {
  assert.deepEqual(reviewStopTerms(row(1n),'90'), {registry,pool,isBid:false,quantity:0n,triggerPrice:90n*10n**18n,triggerOperator:1,stopOrderType:1,intent:'reduceOnly'});
  assert.deepEqual(reviewStopTerms(row(-1n),'110'), {registry,pool,isBid:true,quantity:0n,triggerPrice:110n*10n**18n,triggerOperator:0,stopOrderType:1,intent:'reduceOnly'});
  for (const [size,price] of [[1n,'100'],[1n,'101'],[-1n,'100'],[-1n,'99'],[0n,'90']]) assert.equal(reviewStopTerms(row(size),price),null);
  assert.equal(reviewStopTerms({...row(1n),market:{...row(1n).market,quoteDecimals:6}},'90'),null);
});
test('price parser does not round or accept invalid input', () => {
  assert.equal(parsePrice('0.000001',6),1n); assert.equal(parsePrice('0.0000001',6),null);
  for (const value of ['0','-1','1e3','01','1.','NaN']) assert.equal(parsePrice(value,18),null);
  assert.equal(parsePrice((1n<<256n).toString(),0),null); assert.equal(parsePrice('9'.repeat(121),18),null);
});
test('states do not infer fill or terminal outcome from missing chain state', () => {
  assert.equal(mapStopState({owner},null,owner).state,'pending');
  assert.equal(mapStopState(null,{owner,status:'PENDING'},owner).state,'unknown');
  assert.equal(mapStopState(null,null,owner).state,'unknown');
  assert.equal(mapStopState({owner:registry},null,owner).state,'unknown');
  assert.equal(mapStopState(null,{owner,status:'TRIGGERED',placedOrderId:'42'},owner).state,'order placed');
  assert.equal(mapStopState(null,{owner,status:'TRIGGERED',placedOrderId:null},owner).state,'triggered');
  assert.equal(mapStopState(null,{owner,status:'TRIGGER_FAILED',dropReason:'PlacementFailed'},owner).state,'failed or dropped');
  assert.equal(mapStopState(null,{owner,status:'CANCELLED'},owner).state,'cancelled');
});
test('references are canonical uint128 ids and addresses', () => {
  assert.equal(validStopReference(registry,'0'),true); assert.equal(validStopReference(registry,((1n<<128n)-1n).toString()),true);
  assert.equal(validStopReference(registry,(1n<<128n).toString()),false); assert.equal(validStopReference(registry,'01'),false); assert.equal(validStopReference('bad','1'),false);
});


test('registry must match exactly one current BTC or ETH market for selected pool', () => {
  const selected=row(1n);
  const market={poolAddress:pool,baseSymbol:'BTC',stopRegistry:registry};
  assert.equal(matchesDiscoveredMarket(selected,[market]),true);
  assert.equal(matchesDiscoveredMarket(selected,[{...market,stopRegistry:owner}]),false);
  assert.equal(matchesDiscoveredMarket(selected,[{...market,poolAddress:owner}]),false);
  assert.equal(matchesDiscoveredMarket(selected,[{...market,baseSymbol:'ETH'}]),false);
  assert.equal(matchesDiscoveredMarket(selected,[market,market]),false);
  assert.equal(matchesDiscoveredMarket(selected,[]),false);
});
