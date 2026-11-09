// db_util.js - IndexedDB cache helpers
import {openDB} from 'idb';

let db;
export async function db_init(){
  db = await openDB('bright-wallet', 3, {
    upgrade(db, old_ver){
      if (old_ver<1)
        db.createObjectStore('cache');
      if (old_ver<2)
        db.createObjectStore('headers');
      if (old_ver<3){
        db.createObjectStore('txs');
        db.createObjectStore('sh_history');
      }
    }
  });
}
export async function hdr_get(net, height){
  return await db.get('headers', [net, height]) ?? null;
}
export async function hdr_put(net, height, data){
  await db.put('headers', data, [net, height]);
}
export async function hdr_get_tip(net){
  let range = IDBKeyRange.bound([net, 0], [net, Infinity]);
  let tx = db.transaction('headers', 'readonly');
  let cursor = await tx.objectStore('headers').openCursor(range, 'prev');
  return cursor?.value ?? null;
}
export async function hdr_get_range(net, from, to){
  let range = IDBKeyRange.bound([net, from], [net, to]);
  return await db.getAll('headers', range);
}
export async function tx_get(txid){
  return await db.get('txs', txid) ?? null;
}
export async function tx_put(txid, data){
  await db.put('txs', data, txid);
}
export async function sh_history_get(sh){
  return await db.get('sh_history', sh) ?? null;
}
export async function sh_history_put(sh, data){
  await db.put('sh_history', data, sh);
}
export async function db_get(id){
  try {
    return await db.get('cache', id) ?? null;
  } catch{ return null; }
}
export async function db_put(id, data){
  try {
    await db.put('cache', data, id);
  } catch{}
}
export async function cache_clear(){
  try { await db.clear('cache'); } catch{}
}

export const cache_ver = '2';
