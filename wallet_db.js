// wallet_db.js - bright wallet database and network
import * as bitcoin from 'bitcoinjs-lib';
import {T, OE, OV, OA, CE, CEL, ewait, assert,
  _try, version as util_version, date_time, str, lif_url_tr,
} from 'lif-kernel/util.js';
import {lifnet} from 'lif-kernel/lifnet';
let lif = globalThis.$lif ||= {};
lif.assert = assert;
import etask from 'lif-kernel/etask.js';
import {buf_from_hex, buf_to_hex, HD_SCAN_GAP, DUST_VAL, g_settings,
  netconf_def, LIF_SERVER_DEF, settings_load, settings_save, settings_get,
  settings_cs_load, settings_cs_fetch, lif_server_get, lif_server_set,
  addr_sh, hd_root, hd_path_def, hd_addr, hd_wallet, addr_valid,
} from './settings.js';
import {db_init, db_get, db_put, cache_clear, cache_ver} from './db_util.js';
import {_el} from './electrum.js';
import {wc_locate_addr} from './wallet_chain.js';

export {buf_from_hex, buf_to_hex, LIF_SERVER_DEF, settings_save, settings_get,
  settings_cs_fetch, lif_server_get, lif_server_set,
  addr_sh, hd_root, hd_path_def, hd_addr, hd_wallet, addr_valid,
  _el};

let use_wc = localStorage.getItem('use_wc');

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
  const root = wallet_root(wallet);
  const ap = wallet.derivPath || hd_path_def(netconf);
  c.addrs = cs.addrs.map(a=>({...a,
    ...hd_addr(network, root, ap, a.chain, a.index)}));
  c.changeAddrInfo = cs.changeAddrInfo
    ? {...cs.changeAddrInfo, ...hd_addr(network, root, ap,
      cs.changeAddrInfo.chain, cs.changeAddrInfo.index)}
    : null;
  c.utxos = cs.utxos.map(u=>({
    ...u, addrInfo: cs.addrs.find(a=>a.address==u.address)||
      hd_addr(network, root, ap, u.chain, u.index)
  }));
}

// Preload all wallets from IndexedDB into memory at module startup
export async function wallet_db_init(){
  await db_init();
  await settings_load();
  wallets_load();
  for (const w of OV(g_wallets))
    await wallet_cs_load(w);
}

async function _wallet_fetch(wallet){
  const {netconf, network, ls, c, cs} = wallet;
  const el = _el(netconf);
  const root = wallet_root(wallet);
  const ap = ls.derivPath || hd_path_def(netconf);
  const [extRes, chgRes] = await Promise.all([
    hd_scan(netconf, root, ap, 0),
    hd_scan(netconf, root, ap, 1),
  ]);
  const addrs = c.addrs = [...extRes.used, ...chgRes.used];
  cs.addrs = c.addrs.map(({address, chain, index, hist})=>(
    {address, chain, index, hist}));
  c.receiveAddress = hd_addr(network, root, ap, 0, extRes.nextIndex)
    .address;
  cs.receiveAddress = c.receiveAddress;
  c.changeAddrInfo = hd_addr(network, root, ap, 1, chgRes.nextIndex);
  cs.changeAddrInfo = c.changeAddrInfo
    ? {address: c.changeAddrInfo.address,
      chain: c.changeAddrInfo.chain, index: c.changeAddrInfo.index}
    : null;
  const addr_set = new Set(addrs.map(a=>a.address));
  const [utxo_list, bals] = await Promise.all([
    Promise.all(addrs.map(async(a)=>{
      const unspent = await el.sh_listunspent(addr_sh(a.address, network));
      return unspent.map(u=>({...u, address: a.address, chain: a.chain, index: a.index}));
    })),
    Promise.all(addrs.map(async(a)=>{
      let bal = await el.sh_get_balance(addr_sh(a.address, network));
      return bal;
    })),
  ]);
  c.utxos = utxo_list.flat().map(u=>({...u, addrInfo: addrs.find(
    a=>a.address==u.address)}));
  cs.utxos = c.utxos.map(({tx_hash, tx_pos, value, address, chain, index})=>
    ({tx_hash, tx_pos, value, address, chain, index}));
  c.confirmed = bals.reduce((s, b)=>s+b.confirmed, 0);
  c.unconfirmed = bals.reduce((s, b)=>s+b.unconfirmed, 0);
  c.balance = c.confirmed+c.unconfirmed;
  cs.confirmed = c.confirmed;
  cs.unconfirmed = c.unconfirmed;
  cs.balance = c.balance;
  c.feeRate = await el_estimatefee(netconf);
  cs.feeRate = c.feeRate;
  // Transactions
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
    const heights = [...new Set(hist.filter(t=>t.height>0).map(t=>t.height))];
    const [verboseTxs, ...headers] = await Promise.all([
      Promise.all(hist.map(t=>el.tx_get(t.tx_hash, true))),
      ...heights.map(h=>el.block_header(h)),
    ]);
    const tsMap = {};
    heights.forEach((h, i)=>{
      tsMap[h] = buf_from_hex(headers[i]).readUInt32LE(68);
    });
    const histTxIds = new Set(hist.map(t=>t.tx_hash));
    const prevIds = [...new Set(verboseTxs.flatMap(vtx=>(vtx.vin||[]).map(
      vin=>vin.txid).filter(id=>id&&!histTxIds.has(id))))];
    const prevList = await Promise.all(prevIds.map(id=>el.tx_get(id, true)));
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
  let wait;
  if (!force && (wait = wallet.c_wait))
    return await wait;
  wait = wallet.c_wait = ewait();
  return wait.return(await _wallet_fetch(wallet));
}

function wallet_root(wallet){
  const {ls, c, netconf} = wallet;
  if (c.root)
    return c.root;
  return c.root = hd_root(ls.mnemonic, netconf.network, ls.passphrase||'');
}

// Scan used addresses on chain (0=external, 1=change) with gap limit of 20.
// Returns {used: [{address, keyPair, chain, index, hist}], nextIndex}
export async function hd_scan(netconf, root, accountPath, chain){
  const network = netconf.network;
  const el = _el(netconf);
  const GAP = HD_SCAN_GAP;
  const used = [];
  let lastUsed = -1;
  let start = 0;
  while (true){
    const entries = Array.from({length: GAP},
      (_, i)=>hd_addr(network, root, accountPath, chain, start+i));
    const hists = await Promise.all(
      entries.map(e=>el.sh_get_history(addr_sh(e.address, network)))
    );
    let anyUsed = false;
    for (let i=0; i<GAP; i++){
      if (hists[i].length>0){
        used.push({...entries[i], hist: hists[i]});
        lastUsed = entries[i].index;
        anyUsed = true;
      }
    }
    if (!anyUsed)
      break;
    start += GAP;
  }
  return {used, nextIndex: lastUsed+1};
}

export async function el_estimatefee(netconf){
  const fallback = netconf.fee_def;
  try {
    const rate = await _el(netconf).estimatefee(6);
    if (rate>0)
      return Math.round(rate*1e8);
  } catch(e){}
  return fallback;
}

function kv_script(key, val, valbin){
  let ops = [];
  ops.push(bitcoin.opcodes.OP_RETURN, Buffer.from('lif'));
  ops.push(Buffer.from('key'), Buffer.from(key));
  ops.push(Buffer.from('val'), Buffer.from(val));
  if (valbin)
    ops.push(Buffer.from('valbin'), Buffer.from(valbin));
  return bitcoin.script.compile(ops);
}

export async function tx_broadcast(netconf, tx){
  let txid = await _el(netconf).tx_broadcast(tx.toHex());
  if (txid!=tx.getId())
    return void console.error(`mistmatch txid ${txid} ${tx.getId()}`);
  return txid;
}

export function fee_calc(rateSatPerKb, tx){
  return Math.ceil(rateSatPerKb/1000*tx.virtualSize());
}

export function hd_addr_find(root, accountPath, network, saddr_find){
  for (let ch=0; ch<2; ch++){
    for (let idx=0; idx<30; idx++){
      const info = hd_addr(network, root, accountPath, ch, idx);
      if (info.address==saddr_find)
        return info;
    }
  }
}

function tx_psbt(network){
  const p = new bitcoin.Psbt({network});
  // disable this 'overpriced fee'. This logic should be in UI
  // since max TX size if 1e6 (1MB blocks) and max 21M coins, so to disable
  // we set it to number of all satoshis, divided by block size in bytes
  p.setMaximumFeeRate(20e6*1e8/1e6);
  return p;
}

const u8arr_cmp = indexedDB.cmp.bind(indexedDB);
const u8arr_eq = (a, b)=>!u8arr_cmp(a, b);

export function tx_out_find(network, tx, saddr){
  const addr = bitcoin.address.toOutputScript(saddr, network);
  for (let i=0; i<tx.outs.length; i++){
    const out = tx.outs[i];
    if (!u8arr_eq(out.script, addr))
      continue;
    return {index: i, value: out.value, out};
  }
}

function psbt_input_get_value(psbt, vin){
  const in_data = psbt.data.inputs[vin];
  // Most common case: Native SegWit / Taproot
  if (in_data.witnessUtxo)
    return in_data.witnessUtxo.value;
  // Legacy / Nested SegWit case
  if (in_data.nonWitnessUtxo){
    const prevTx = bitcoin.Transaction.fromBuffer(in_data.nonWitnessUtxo);
    const outputIndex = psbt.txInputs[vin].index;
    return prevTx.outs[outputIndex].value;
  }
  // No value information available
  throw new Error(`Input ${vin} missing value info (witnessUtxo or nonWitnessUtxo)`);
}

export function wallet_bal(wallet){
  const {c, network} = wallet;
  const utxos = [...c.utxos].filter(u=>u.value>DUST_VAL);
  return utxos.reduce((sum, u)=>sum+u.value, 0);
}

function tx_fund({wallet, p, in_sign=[], fee}){
  const {c, netconf, network} = wallet;
  const _sum_out = Number(
    p.txOutputs.reduce((sum, output)=>sum+output.value, 0n));
  in_sign = [...in_sign];
  if (fee==null){ // estimate fee: mock tx
    let {mock} = netconf;
    p.addInput({hash: mock.tx_hash, index: 0,
      witnessUtxo: {value: BigInt(_sum_out+1),
      script: bitcoin.address.toOutputScript(mock.address, network)}});
    in_sign.push(mock);
    p.addOutput({address: mock.address, value: 1n});
    for(let i=0; i<in_sign.length; i++)
      p.signInput(i, in_sign[i].keyPair);
    p.finalizeAllInputs();
    const tx = p.extractTransaction();
    return {tx, fee};
  }
  fee ||= 1; // require minimal funding for estimation
  const needed = _sum_out+fee;
  let sum_in = 0;
  for (let i=0; i<p.inputCount; i++)
    sum_in += Number(psbt_input_get_value(p, i));
  const sum_out = _sum_out+fee;
  // sort from big to small
  // filter out 0 value (which are probably lif kv coins) and
  // and dust coins.
  const utxos = [...c.utxos].sort((a,b)=>b.value-a.value)
  .filter(u=>u.value>DUST_VAL);
  const selected = [];
  if (sum_in>=sum_out)
    ; // no need funding
  else if (!utxos.length)
    return {err: "no funds"};
  else if (utxos[0].value>=sum_out-sum_in){
    // single coin funding: find smallest single coin that is still enough
    let coin = utxos[0];
    for (const u of utxos){
      if (u.value<sum_out-sum_in)
        break;
      coin = u;
    }
    selected.push(coin);
    sum_in += Number(coin.value);
  } else {
    // fund with multiple coins
    for (const u of utxos){
      selected.push(u);
      sum_in += Number(u.value);
      if (sum_in>=sum_out)
        break;
    }
  }
  for (const u of selected){
    p.addInput({hash: u.tx_hash, index: u.tx_pos,
      witnessUtxo: {value: BigInt(u.value),
      script: bitcoin.address.toOutputScript(u.addrInfo.address, network)}});
    in_sign.push(u.addrInfo);
  }
  if (sum_in<sum_out)
    return {err: "insufficient funds"};
  if (sum_in-sum_out>DUST_VAL){
    let chg = sum_in-sum_out; // add output to change
    p.addOutput({address: c.changeAddrInfo.address, value: BigInt(chg)});
  }
  for(let i=0; i<in_sign.length; i++)
    p.signInput(i, in_sign[i].keyPair);
  p.finalizeAllInputs();
  const tx = p.extractTransaction();
  return {utxos: in_sign, tx, pstb: p, fee, _fee: sum_in-sum_out};
}

// fee==null mock estimate, fee=0 fund real TX auto set fee
// in_calc - prevent loops
function tx_fee_calc(tx_fn, arg){
  let {wallet, fee} = arg;
  if (fee==null){
    let tx = tx_fn({...arg, fee, in_calc: true});
    if (tx.err)
      return tx;
    tx.fee = fee_calc(wallet.c.feeRate, tx.tx);
    return tx;
  }
  // fee==0: real TX, auto set fee
  let tx = tx_fn({...arg, fee: 1, in_calc: true});
  fee = fee_calc(wallet.c.feeRate, tx.tx);
  return tx_fn({...arg, fee, in_calc: true});
}

export function tx_send({wallet, saddr_to, value, fee, in_calc}){
  if (!fee && !in_calc)
    return tx_fee_calc(tx_send, arguments[0]);
  const {network} = wallet;
  const p = tx_psbt(network);
  p.addOutput({address: saddr_to, value: BigInt(value)});
  return tx_fund({wallet, p, fee});
}

export function kv_tx_add({wallet, key, val, fee, in_calc}){
  if (!fee && !in_calc)
    return tx_fee_calc(kv_tx_add, arguments[0]);
  const {c, network} = wallet;
  const p = tx_psbt(network);
  p.addOutput({script: kv_script(key, val), value: 0n});
  p.addOutput({address: c.changeAddrInfo.address, value: 1n});
  // XXX dont reuse same changeAddrInfo for change - inc next change addr
  return tx_fund({wallet, p, fee});
}

export function kv_tx_send({wallet, kv_d, saddr_to, fee, in_calc}){
  if (!fee && !in_calc)
    return tx_fee_calc(kv_tx_send, arguments[0]);
  const {c, network} = wallet;
  const p = tx_psbt(network);
  const vout = kv_d._tx._vtx.vout[kv_d.vout];
  const value = Math.round(vout.value*1e8);
  const saddr = vout.scriptPubKey?.address ||
    vout.scriptPubKey?.addresses?.[0];
  const addr = c.addrs.find(a=>a.address==saddr);
  if (!addr)
    throw new Error('Name UTXO address of KV not found in wallet');
  const in_sign = [];
  p.addInput({hash: kv_d.tx, index: kv_d.vout,
    witnessUtxo: {value: BigInt(value),
      script: bitcoin.address.toOutputScript(saddr, network)}});
  in_sign.push(addr);
  p.addOutput({address: saddr_to, value: 1n});
  return tx_fund({wallet, p, in_sign, fee});
}

export function kv_tx_edit({wallet, kv_d, fee, in_calc}){
  if (!fee && !in_calc)
    return tx_fee_calc(kv_tx_edit, arguments[0]);
  const {c, network} = wallet;
  const p = tx_psbt(network);
  const vout = kv_d._tx._vtx.vout[kv_d.vout];
  const value = Math.round(vout.value*1e8);
  const saddr = vout.scriptPubKey?.address ||
    vout.scriptPubKey?.addresses?.[0];
  const addr = c.addrs.find(a=>a.address==saddr);
  if (!addr)
    throw new Error('Name UTXO address of KV not found in wallet');
  const in_sign = [];
  p.addInput({hash: kv_d.tx, index: kv_d.vout,
    witnessUtxo: {value: BigInt(value),
      script: bitcoin.address.toOutputScript(saddr, network)}});
  in_sign.push(addr);
  p.addOutput({script: kv_script(kv_d.key, kv_d.val), value: 0n});
  p.addOutput({address: c.changeAddrInfo.address, value: 1n});
  return tx_fund({wallet, p, in_sign, fee});
}

export const LIF_DOMAINS = ['pub.site', 'lif.site', 'lif.zone'];
export function kv_is_dns(key){
  if (!key.startsWith('dns/'))
    return;
  let dns = key.slice(4);
  if (!/^[a-z0-9-_]+$/.test(dns))
    return;
  return dns;
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
  if (use_wc)
    return wc_locate_addr(addr);
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

