// wallet_db.js - bright wallet database and network
import {T, OE, OV, OA, CE, CEL, ewait, assert,
  _try, version as util_version, date_time, str, lif_url_tr,
} from 'lif-kernel/util.js';
import {lifnet} from 'lif-kernel/lifnet';
let lif = globalThis.$lif ||= {};
lif.assert = assert;
import etask from 'lif-kernel/etask';
import {buf_from_hex, buf_to_hex, HD_SCAN_GAP, g_settings,
  netconf_def, LIF_SERVER_DEF, settings_load, settings_save, settings_get,
  settings_cs_load, settings_cs_fetch, lif_server_get, lif_server_set,
  addr_sh, hd_root, hd_path_def, hd_addr, hd_wallet, addr_valid,
  parse_xpub, xpub_derive_addr,
} from './settings.js';
import {db_init, db_get, db_put, cache_clear, db_clear_all, cache_ver,
  tx_get, tx_put} from './db_util.js';
import {_el} from './electrum.js';
import {wc_init, wc_sync_headers, wc_hd_scan, wc_zpub_scan, wc_addr_scan,
  wc_store_tx, wc_get_balance, wc_listunspent, wc_get_tx, wc_get_header,
  wc_tx_get_verbose, wc_check_reorg} from './wallet_chain.js';
import {el_estimatefee, tx_broadcast, fee_calc, hd_addr_find, tx_out_find,
  wallet_bal, tx_send, kv_tx_add, kv_tx_send, kv_tx_edit,
  LIF_DOMAINS, kv_is_dns} from './tx_create.js';

export {buf_from_hex, buf_to_hex, LIF_SERVER_DEF, settings_save, settings_get,
  settings_cs_fetch, lif_server_get, lif_server_set,
  addr_sh, hd_root, hd_path_def, hd_addr, hd_wallet, addr_valid,
  _el, el_estimatefee, tx_broadcast, fee_calc, hd_addr_find, tx_out_find,
  wallet_bal, tx_send, kv_tx_add, kv_tx_send, kv_tx_edit,
  LIF_DOMAINS, kv_is_dns, db_clear_all, parse_xpub, xpub_derive_addr};


lifnet.set_opt({client_name: 'wallet'});

// id → single wallet object instance (mutated in place)
const g_wallets = {};

export function wallets_load(){
  for (let id in g_wallets)
    _wallet_del(id);
  let wallets_ls = T(()=>JSON.parse(localStorage.getItem('wallets'))) || {};
  for (const [id, ls] of OE(wallets_ls)){
    if (ls.id!=id){
      console.error(`invalid wallet id ${ls.id} ${id}`);
      ls.id = id;
    }
    _wallet_add(ls);
  }
  return g_wallets;
}

export function wallets_get(){
  return g_wallets;
}

export function wallets_save(){
  const wallets_ls = {};
  for (const [id, w] of OE(g_wallets))
    wallets_ls[id] = w.ls;
  localStorage.setItem('wallets', JSON.stringify(wallets_ls));
}

export function wallet_get(id){
  return g_wallets[id];
}

function _wallet_add(w_ls){
  let netconf = g_settings.netconf;
  let wallet = {
    ls: {...w_ls},
    c: {},
    cs: {},
    netconf: netconf[w_ls.network],
  };
  wallet.network = wallet.netconf.network;
  wallet.ls.name ||= '';
  g_wallets[wallet.ls.id] = wallet;
}

export function wallet_add(w_ls){
  _wallet_add(w_ls);
  wallets_save();
}

export function wallet_update(id){
  wallets_save();
}

function _wallet_del(id){
  delete g_wallets[id];
}

export function wallet_del(id){
  _wallet_del(id);
  wallets_save();
}

export async function wallet_cache_clear(){
  await cache_clear();
  for (const w of OV(g_wallets)){
    w.c = {};
    w.cs = {};
  }
}

// Populate wallet with cached data from IndexedDB (re-derives keyPairs from
// mnemonic). Idempotent: does nothing if wallet already has
// data (wallet.c.addrs defined).
async function wallet_cs_load(wallet){
  const {c, cs, netconf, network} = wallet;
  if (cs.addrs)
    return;
  const _cs = await db_get('walletData:'+wallet.ls.id);
  if (!_cs)
    return;
  if (_cs.cache_ver!=cache_ver)
    return console.log(`cache_ver changed ${cs.cache_ver} -> ${cache_ver}`);
  OA(cs, _cs);
  OA(c, _cs);
  let {ls} = wallet;
  if (ls.type=='watch' || ls.type=='zpub'){
    c.addrs = cs.addrs || [];
    c.changeAddrInfo = cs.changeAddrInfo || null;
    c.utxos = (cs.utxos||[]).map(u=>({
      ...u, addrInfo: c.addrs.find(a=>a.address==u.address)
    }));
  } else {
    const root = wallet_root(wallet);
    const ap = ls.derivPath || hd_path_def(netconf);
    c.addrs = cs.addrs.map(a=>({...a,
      ...hd_addr(network, root, ap, a.chain, a.index)}));
    c.changeAddrInfo = cs.changeAddrInfo
      ? {...cs.changeAddrInfo, ...hd_addr(network, root, ap,
        cs.changeAddrInfo.chain, cs.changeAddrInfo.index)}
      : null;
    c.utxos = (cs.utxos||[]).map(u=>({
      ...u, addrInfo: cs.addrs.find(a=>a.address==u.address)||
        hd_addr(network, root, ap, u.chain, u.index)
    }));
  }
}

// Preload all wallets from IndexedDB into memory at module startup
export async function wallet_db_init(){
  await db_init();
  await settings_load();
  wallets_load();
  for (const w of OV(g_wallets))
    await wallet_cs_load(w);
}

async function _wallet_fetch(wallet, refresh){
  const {netconf, network, ls, c, cs} = wallet;
  const el = _el(netconf);
  await wc_init(netconf);
  // Get chain height for cache staleness check
  let sub = await el.headers_subscribe();
  let chain_height = sub.error ? 0 : sub.height;
  // Check for reorg before syncing
  let reorg = await wc_check_reorg(netconf, chain_height);
  if (reorg.reorg){
    console.log('_wallet_fetch: reorg detected, fork at',
      reorg.fork_height);
    refresh = true;
  }
  // Scan addresses based on wallet type
  let addrs, receiveAddress, changeAddrInfo;
  if (ls.type=='watch'){
    let res = await wc_addr_scan(netconf, ls.addresses||[],
      chain_height, refresh);
    addrs = res.used;
    receiveAddress = ls.addresses?.[0] || '';
    changeAddrInfo = null;
  } else if (ls.type=='zpub'){
    let node = parse_xpub(ls.zpub, network);
    const [extRes, chgRes] = await Promise.all([
      wc_zpub_scan(netconf, node, 0, chain_height, refresh),
      wc_zpub_scan(netconf, node, 1, chain_height, refresh),
    ]);
    addrs = [...extRes.used, ...chgRes.used];
    receiveAddress = xpub_derive_addr(network, node, 0,
      extRes.nextIndex).address;
    changeAddrInfo = xpub_derive_addr(network, node, 1,
      chgRes.nextIndex);
  } else {
    const root = wallet_root(wallet);
    const ap = ls.derivPath || hd_path_def(netconf);
    const [extRes, chgRes] = await Promise.all([
      wc_hd_scan(netconf, root, ap, 0, chain_height, refresh),
      wc_hd_scan(netconf, root, ap, 1, chain_height, refresh),
    ]);
    addrs = [...extRes.used, ...chgRes.used];
    receiveAddress = hd_addr(network, root, ap, 0,
      extRes.nextIndex).address;
    changeAddrInfo = hd_addr(network, root, ap, 1, chgRes.nextIndex);
  }
  c.addrs = addrs;
  // Sync headers for confirmed TXes, then store all TXes
  let all_tx = addrs.flatMap(a=>(a.hist||[]).map(h=>h));
  let confirmed_heights = [...new Set(all_tx.filter(h=>h.height>0)
    .map(h=>h.height))];
  let hdr_res = await wc_sync_headers(netconf, confirmed_heights,
    chain_height);
  if (hdr_res.error)
    console.error('wc_sync_headers:', hdr_res.error);
  let fork_height = reorg.reorg ? reorg.fork_height : Infinity;
  await Promise.all(all_tx.map(h=>
    wc_store_tx(netconf, h.tx_hash, h.height, h.height>fork_height)));
  // Rebroadcast our local unconfirmed TXes (only for non-watch wallets)
  if (!ls.type || ls.type=='hd'){
    let unconf = all_tx.filter(h=>h.height<=0);
    let now = Date.now();
    for (let h of unconf){
      let entry = await tx_get(h.tx_hash);
      if (!entry?.local || !entry.raw)
        continue;
      if (entry.broadcast_ts && now-entry.broadcast_ts>24*60*60*1000)
        continue;
      try {
        await el.tx_broadcast(entry.raw);
        entry.broadcast_ts = Date.now();
        await tx_put(h.tx_hash, entry);
      } catch(e){}
    }
  }
  cs.addrs = c.addrs.map(({address, chain, index, hist})=>(
    {address, chain, index, hist}));
  c.receiveAddress = receiveAddress;
  cs.receiveAddress = receiveAddress;
  c.changeAddrInfo = changeAddrInfo;
  cs.changeAddrInfo = changeAddrInfo
    ? {address: c.changeAddrInfo.address,
      chain: c.changeAddrInfo.chain, index: c.changeAddrInfo.index}
    : null;
  // Balance + UTXOs from local DB
  const bal = await wc_get_balance(netconf, addrs);
  c.confirmed = bal.confirmed;
  c.unconfirmed = bal.unconfirmed;
  c.balance = c.confirmed+c.unconfirmed;
  cs.confirmed = c.confirmed;
  cs.unconfirmed = c.unconfirmed;
  cs.balance = c.balance;
  const utxos = await wc_listunspent(netconf, addrs);
  c.utxos = utxos.map(u=>({...u, addrInfo: addrs.find(
    a=>a.address==u.address)}));
  cs.utxos = utxos;
  c.feeRate = await el_estimatefee(netconf);
  cs.feeRate = c.feeRate;
  // Transactions from local DB
  const addr_set = new Set(addrs.map(a=>a.address));
  const txByHash = new Map();
  for (const a of addrs){
    for (const tx of (a.hist||[]))
      txByHash.set(tx.tx_hash, tx);
  }
  const hist = [...txByHash.values()].sort((a, b)=>(b.height||1e9)
    -(a.height||1e9));
  c.transactions = [];
  c.ownedKeys = [];
  if (hist.length){
    const verboseTxs = await Promise.all(hist.map(t=>
      wc_tx_get_verbose(netconf, t.tx_hash)));
    // Get timestamps from local headers
    const heights = [...new Set(hist.filter(t=>t.height>0)
      .map(t=>t.height))];
    const tsMap = {};
    for (let h of heights){
      let hdr = await wc_get_header(netconf, h);
      if (hdr)
        tsMap[h] = hdr.time;
    }
    const histTxIds = new Set(hist.map(t=>t.tx_hash));
    const prevIds = [...new Set(verboseTxs.flatMap(vtx=>(vtx.vin||[]).map(
      vin=>vin.txid).filter(id=>id&&!histTxIds.has(id))))];
    const prevList = await Promise.all(prevIds.map(id=>
      wc_tx_get_verbose(netconf, id)));
    const prevMap = {};
    prevIds.forEach((id, i)=>{ prevMap[id]=prevList[i]; });
    verboseTxs.forEach(vtx=>{ prevMap[vtx.txid]=vtx; });
    const voutToOurAmt=(vouts)=>(vouts||[]).reduce((sum, vout)=>{
      const as = vout.scriptPubKey?.addresses||(vout.scriptPubKey?.address ?
        [vout.scriptPubKey.address] : []);
      return as.some(a=>addr_set.has(a)) ? sum+Math.round(vout.value*1e8)
        : sum;
    }, 0);
    c.transactions = hist.map((tx, i)=>{
      const vtx = verboseTxs[i];
      const enrichedVin = (vtx.vin||[]).map(vin=>{
        if (!vin.txid)
          return vin;
        return {...vin, _prevVout: prevMap[vin.txid]?.vout?.[vin.vout]};
      });
      const received = voutToOurAmt(vtx.vout);
      const spent = enrichedVin.reduce((sum, vin)=>{
        if (!vin._prevVout)
          return sum;
        const as = vin._prevVout.scriptPubKey?.addresses ||
          (vin._prevVout.scriptPubKey?.address ?
          [vin._prevVout.scriptPubKey.address] : []);
        return as.some(a=>addr_set.has(a)) ?
          sum+Math.round(vin._prevVout.value*1e8) : sum;
      }, 0);
      const totalIn = enrichedVin.reduce((s, vin)=>
        vin._prevVout ? s+Math.round(vin._prevVout.value*1e8) : s, 0);
      const totalOut = (vtx.vout||[]).reduce((s, vout)=>
        s+Math.round(vout.value*1e8), 0);
      const fee = totalIn > 0 ? totalIn-totalOut : null;
      return {...tx, timestamp: tx.height>0 ? tsMap[tx.height] : null,
        amount: received-spent, fee, _vtx: {...vtx, vin: enrichedVin}};
    });
    if (netconf.lif_kv){
      const keyMap = new Map();
      for (const etx of c.transactions){
        const vouts = etx._vtx?.vout||[];
        for (let i=0; i<vouts.length; i++){
          const vout = vouts[i];
          if (!vout.lif_kv)
            continue;
          const saddr = vout.scriptPubKey?.address ||
            vout.scriptPubKey?.addresses?.[0];
          if (!addr_set.has(saddr))
            continue;
          for (const kv of vout.lif_kv){
            const isUnconfirmed = etx.height<=0;
            const priority = isUnconfirmed ? Infinity : etx.height;
            const existing = keyMap.get(kv.key);
            if (!existing || priority>=existing._priority){
              const _kstatus = vout.spent ? 'spent' : isUnconfirmed ?
                'receiving' : 'confirmed';
              keyMap.set(kv.key, {key: kv.key, val: kv.val, tx: etx.tx_hash,
                vout: i, _kstatus, _priority: priority});
            }
          }
        }
      }
      c.ownedKeys = [...keyMap.values()];
    }
  }
  cs.transactions = c.transactions;
  cs.ownedKeys = c.ownedKeys;
  cs.cache_ver = cache_ver;
  await db_put('walletData:'+ls.id, cs);
  return wallet;
}

export async function wallet_fetch(wallet, force){
  let refresh = wallet._refresh;
  wallet._refresh = false;
  if (!force && !refresh && (wallet.c_wait))
    return await wallet.c_wait;
  let wait = wallet.c_wait = ewait();
  // Always re-query histories on wallet entry (force=true) to detect
  // mempool changes (mempool doesn't advance chain tip, so checked_height
  // cache would miss them). refresh=true forces full re-query.
  return wait.return(await _wallet_fetch(wallet, force || refresh));
}

function wallet_root(wallet){
  const {ls, c, netconf} = wallet;
  if (c.root)
    return c.root;
  return c.root = hd_root(ls.mnemonic, netconf.network, ls.passphrase||'');
}

// Subscribe to electrum notifications for background sync.
// Subscribes to headers and all wallet scripthashes.
// Calls on_update(wallet) when data changes.
// Returns cleanup function.
export async function wallet_subscribe(wallet, on_update){
  let {netconf, network} = wallet;
  let el = _el(netconf);
  let addrs = wallet.c.addrs || [];
  let shs = new Set();
  for (let a of addrs)
    shs.add(addr_sh(a.address, network));
  if (wallet.c.receiveAddress)
    shs.add(addr_sh(wallet.c.receiveAddress, network));
  if (wallet.c.changeAddrInfo?.address)
    shs.add(addr_sh(wallet.c.changeAddrInfo.address, network));
  await Promise.all([...shs].map(sh=>el.sh_subscribe(sh)));
  let updating = false;
  const do_update = async()=>{
    if (updating)
      return;
    updating = true;
    try {
      wallet._refresh = true;
      await _wallet_fetch(wallet, true);
      on_update?.(wallet);
    } catch(e){
      console.error('wallet_subscribe update error:', e);
    } finally {
      updating = false;
    }
  };
  const on_header = ()=>do_update();
  const on_sh = (params)=>{
    let [sh] = params;
    if (shs.has(sh))
      do_update();
  };
  el.on('header', on_header);
  el.on('scripthash', on_sh);
  return ()=>{
    el.off('header', on_header);
    el.off('scripthash', on_sh);
  };
}

// Returns {wallet, txs, walletAddrs, addrInfo: null} if txid found in any wallet, or null
export function wallet_locate_txid(txid){
  for (const wallet of OV(g_wallets)){
    const tx = (wallet.c?.transactions||[]).find(t=>t.tx_hash==txid);
    if (!tx)
      continue;
    const addrs = wallet.c?.addrs||[];
    const walletAddrs = new Set(addrs.map(a=>a.address));
    return {wallet, txs: [tx], walletAddrs, addrInfo: null};
  }
  return null;
}

// Returns {wallet, txs, walletAddrs, addrInfo} if addr found in any wallet, or null
export function wallet_locate_addr(addr){
  for (const wallet of OV(g_wallets)){
    const addrs = wallet.c?.addrs||[];
    const addrInfo = addrs.find(a=>a.address==addr);
    if (!addrInfo)
      continue;
    const walletAddrs = new Set(addrs.map(a=>a.address));
    const txs = (wallet.c?.transactions||[]).filter(t=>{
      const vouts = t._vtx?.vout||[];
      return vouts.some(v=>{
        const a = v.scriptPubKey?.address||v.scriptPubKey?.addresses?.[0];
        return a==addr;
      });
    });
    return {wallet, txs, walletAddrs, addrInfo};
  }
  return null;
}

