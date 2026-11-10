// db_util.js - IndexedDB cache helpers
import {eslow} from 'lif-kernel/util';
import {openDB} from 'idb';

let db;
export async function db_init(){
  let slow = eslow('openDB');
  db = await openDB('bright-wallet', 3, {
    upgrade(db, old_ver, new_ver){
      console.log(`openDB: Upgrading from v${old_ver} to v${new_ver}`);
      if (old_ver<1)
        db.createObjectStore('cache');
      if (old_ver<2)
        db.createObjectStore('headers');
      if (old_ver<3){
        db.createObjectStore('txs');
        db.createObjectStore('sh_history');
      }
    },
    blocked(cur_ver, blocked_ver, event){
      console.warn('openDB: Another tab or connection is keeping an older version open!');
    },
    blocking(cur_ver, blocked_ver, event){
      console.warn('openDB: THIS CONNECTION IS BLOCKING: An upgrade was requested elsewhere; closing now.');
      // Best practice to prevent deadlocks:
      // event.target.close(); 
    },
  });
  slow.end();
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
