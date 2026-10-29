const key=account=>`forsee:hash:50383:${account.toLowerCase()}`;
function database(){return new Promise((resolve,reject)=>{const r=indexedDB.open('forsee-recovery',1);r.onupgradeneeded=()=>r.result.createObjectStore('hashes');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function backupHash(account,hash){
  let session=false,indexed=false;try{sessionStorage.setItem(key(account),hash);session=sessionStorage.getItem(key(account))===hash;}catch{}
  try{const db=await database();indexed=await new Promise(resolve=>{const tx=db.transaction('hashes','readwrite');tx.objectStore('hashes').put(hash,key(account));tx.oncomplete=()=>resolve(true);tx.onerror=()=>resolve(false);tx.onabort=()=>resolve(false);});db.close();}catch{}
  return session||indexed;
}
export async function readBackupHash(account){try{const v=sessionStorage.getItem(key(account));if(v)return v;}catch{}try{const db=await database();const v=await new Promise((resolve,reject)=>{const q=db.transaction('hashes').objectStore('hashes').get(key(account));q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});db.close();return v||null;}catch{return null;}}
export async function clearBackupHash(account){try{sessionStorage.removeItem(key(account));}catch{}try{const db=await database();await new Promise(resolve=>{const tx=db.transaction('hashes','readwrite');tx.objectStore('hashes').delete(key(account));tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();});db.close();}catch{}}
