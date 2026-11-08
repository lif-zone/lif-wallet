// db_util.js - IndexedDB cache helpers
import {openDB} from 'idb';

let db;
export async function db_init(){
  db = await openDB('bright-wallet', 1, {
    upgrade(db){
      db.createObjectStore('cache');
    }
  });
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
