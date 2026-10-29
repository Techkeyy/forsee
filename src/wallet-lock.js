export const walletLockKey=account=>`forsee:action:50383:${account.toLowerCase()}`;
export async function withAccountLock(manager,account,action){if(!manager?.request)throw Error('This browser cannot safely coordinate wallet requests across tabs.');return manager.request(walletLockKey(account),{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('Another tab is already preparing a request for this wallet.');return action();});}

