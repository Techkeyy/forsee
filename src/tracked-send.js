export async function sendTracked({provider,account,call,record,storage,save,clear,classify,beforeRequest=()=>{},backup=async()=>false}) {
  save(storage,record);
  try {beforeRequest();} catch(error) {clear(storage,account);throw error;}
  let hash;
  try {hash=await provider.request({method:'eth_sendTransaction',params:[{from:account,to:call.to,data:call.data,value:`0x${call.value.toString(16)}`}]});}
  catch(error){let e=error;const seen=new Set();while(e && typeof e==='object' && !seen.has(e)){seen.add(e);if(typeof e.hash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(e.hash)){hash=e.hash;break;}e=e.cause;}if(!hash){if(classify(error)==='rejected'){clear(storage,account);return {state:'rejected'};}return {state:'unknown'};}}
  if(typeof hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(hash))return {state:'unknown'};
  try {save(storage,{...record,hash});} catch {const backedUp=await backup(account,hash);return {state:'unknown',hash,backedUp};}
  return {state:'hash',hash};
}
