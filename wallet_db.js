// wallet_db.js - bright wallet database and network
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import ecc from '@bitcoinerlab/secp256k1';
import {BIP32Factory} from 'bip32';
const bip32 = BIP32Factory(ecc);
import {ECPairFactory} from 'ecpair';
const ecpair = ECPairFactory(ecc);
import {openDB} from 'idb';
import {T, OE, OV, OA, CE, CEA, ewait, esleep, assert, rpc_websocket, _try,
  version as util_version, date_time,
} from 'lif-kernel/util.js';
let lif = globalThis.$lif ||= {};
lif.assert = assert;
const sha256 = bitcoin.crypto.sha256;
import {mine, mine_worker_call, mine_steps,
  target_from_nhash, target_to_nhash, target_to_compact,
  header_get_target, header_get_time, header_set_time,
  header_get_nonce, header_set_nonce, target_from_compact,
} from './mine.js';
import etask from 'lif-kernel/etask.js';

function buf_from_hex(b){
  if (Buffer.isBuffer(b))
    return Buffer.from(b);
  return Buffer.from(b, 'hex');
}
function buf_to_hex(b){
  return b.toString('hex');
}
const HD_SCAN_GAP = 20;
const DUST_VAL = 1;

// add Lif network, from lif-coin/lib/protocol/networks.js
let networks_lif = {
  bech32: 'lif',
  bip32: {
    public: 0x019da4e0,
    private: 0x019da380,
  },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
  messagePrefix: '\x18Bitcoin Signed Message:\n',
};

const netconf_def = {
  lif: {
    name: 'Lifcoin', // Life Chai
    symbol: 'LIF',
    network: networks_lif,
    electrum: '/.lif.net/electrum',
    explorer_tx: 'http://localhost:5000/tx/',
    coin_type: 1842,
    fee_def: 5000000, // 1MB = 50LIF
    lif_kv: true,
    pow: 'sha256lif',
    pow_hps: 50000, // Hash/Sec: android ~60,000 hps, Desktop ~100,000 hps
    usd: 1,
  },
  btc: {
    name: 'Bitcoin',
    symbol: 'BTC',
    network: bitcoin.networks.bitcoin,
    //electrum: 'wss://electrumx.nimiq.com:443/electrumx', // restricted from localhost:5000
    electrum: 'wss://bitcoinserver.nl:50004', // unrestricted
    // electrum: 'wss://electrum.blockstream.info:700', // does not work
    explorer_tx: 'https://mempool.space/tx/',
    coin_type: 0,
    fee_def: 1000, // 1MB = 0.01BTC
    usd: 50000,
  },
  btc_testnet: {
    name: 'Bitcoin Testnet',
    symbol: 'tBTC',
    network: bitcoin.networks.testnet,
    electrum: 'wss://electrum.blockstream.info:993',
    explorer_tx: 'https://mempool.space/testnet/tx/',
    coin_type: 1,
    fee_def: 1000,
    test: true,
    usd: 0.01,
  },
};

export const LIF_SERVER_DEF = 'http://localhost:8432';

function ws_origin(){
  let protocol = location.protocol=='http:' ? 'ws:' :
    location.protocol=='https:' ? 'wss:' : assert();
  return protocol+'//'+location.host;
}

async function get_btc_usd() {
  const [cg, binance, cb] = await Promise.all([
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd').then(r => r.json()),
    fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(r => r.json()),
    fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker').then(r => r.json())
  ]);
  const prices = {
    coingecko: cg?.bitcoin?.usd,
    binance: +binance?.price,
    coinbase: +cb?.price,
  };
  // find median
  let p = OV(prices).filter(v=>v).sort();
  p = p.filter(v=>v>=10000); // sanity check BTC > 10,000 USD
  if (!p.length)
    return;
  if (p.length==1)
    return p[0];
  if (p.length==2)
    return (p[0]+p[1])/2;
  let i = Math.floor(p.length/2);
  return p[i];
}

async function settings_cs_load(){
  let s = g_settings;
  let cs = await db_get('settings_cache');
  if (cs && cs.cache_ver!=cache_ver){
    console.log(`cache_ver changed ${cs.cache_ver} -> ${cache_ver}`);
    cs = null;
  }
  if (!cs)
    cs = {cache_ver};
  s.cs ||= cs;
  cs.coin ||= {};
  for (const [k, nc] of OE(s.netconf)){
    let coin = cs.coin[k] ||= {};
    if (coin.usd)
      nc.usd = coin.usd;
  }
}

async function settings_cs_save(){
  let s = g_settings;
  await db_put('settings_cache', s.cs);
}

export async function settings_cs_fetch(){
  let s = g_settings;
  let price_usd = await get_btc_usd();
  if (price_usd)
    s.cs.coin.btc.usd = price_usd;
  await settings_cs_save();
  await settings_cs_load();
}

const g_settings = {};
async function settings_load(){
  g_settings.ls = T(()=>JSON.parse(localStorage.getItem('settings'))) || {};
  const s = g_settings;
  const {ls} = g_settings;
  ls.lif_server ||= LIF_SERVER_DEF;
  ls.devtools = !! ls.devtools;
  ls.netconf ||= {};
  s.netconf = {};
  s.netconf_def = netconf_def;
  for (const [k, nc_def] of OE(netconf_def)){
    let netconf = s.netconf[k] = {...nc_def};
    ls.netconf[k] ||= {};
    OA(netconf, ls.netconf[k]);
    netconf.network.netconf = netconf;
  }
  for (const [k, netconf] of OE(s.netconf)){
    let mnemonic = 'all all all all all all all all all all all all';
    let addrInfo = hd_wallet(mnemonic, k);
    netconf.mock = {
      mnemonic,
      tx_hash: buf_from_hex('1a'.repeat(32)),
      address: addrInfo.address,
      keyPair: addrInfo.keyPair,
    };
  }
  await settings_cs_load();
  return g_settings;
}

export function settings_save(){
  const s = g_settings;
  const {ls} = g_settings;
  for (const [k, nc_def] of OE(netconf_def))
    s.netconf[k].electrum = ls.netconf[k].electrum||nc_def.electrum;
  localStorage.setItem('settings', JSON.stringify(g_settings.ls));
}

export function settings_get(){
  return g_settings;
}

export function lif_server_get(){
  return g_settings.ls.lif_server;
}
export function lif_server_set(val){
  g_settings.ls.lif_server = val;
  settings_save();
}

const g_electrum = {};
class electrum_rpc {
  constructor(netconf){
    this.netconf = netconf;
    let url = netconf.electrum;
    if (url[0]=='/')
      url = ws_origin()+url;
    this.url = url;
  }
  async connect(){
    let rpc;
    if (rpc = g_electrum[this.url]){
      if (!rpc.error)
        return rpc;
      rpc.close();
    }
    rpc = g_electrum[this.url] = new rpc_websocket({jsonrpc: '2.0', D: 1});
    try {
      await rpc.connect({url: this.url});
    } catch(e){
      console.error('roc_connect', e);
      rpc.close();
      throw e; // return
    }
    try {
      this.server_version = await rpc.T_call('server.version',
        ['lif-coin-wallet', '1.4']);
      this.server_banner = await rpc.T_call('server.banner');
    } catch(e){
      console.error('server version rpc', e);
      this.close();
      throw e; // XXX return
    }
    return rpc;
  }
  async call(method, ...params){
    let rpc = await this.connect();
    return await rpc.call(method, params);
  }
  close(){
    const rpc = g_electrum[this.url];
    if (rpc)
      rpc.close();
    delete g_electrum[this.url];
  }
  async tx_get(tx_hash, verb){
    return await this.call('blockchain.transaction.get', tx_hash, verb);
  }
  async tx_broadcast(txraw){
    return await this.call('blockchain.transaction.broadcast', txraw);
  }
  async sh_get_balance(sh){
    return await this.call('blockchain.scripthash.get_balance', sh);
  }
  async sh_get_history(sh){
    return await this.call('blockchain.scripthash.get_history', sh);
  }
  async sh_listunspent(sh){
    return await this.call('blockchain.scripthash.listunspent', sh);
  }
  async block_header(height){
    return await this.call('blockchain.block.header', height);
  }
  async estimatefee(nblocks){
    return await this.call('blockchain.estimatefee', nblocks);
  }
  async lif_kv_get(key){
    return await this.call('blockchain.lif_kv.get', key);
  }
  async mine_get_template(saddr){
    return await this.call('blockchain.mine.get_template', saddr);
  }
  async mine_submit_header(header){
    return await this.call('blockchain.mine.submit_header', header);
  }
}

export function _el(netconf){
  return new electrum_rpc(netconf);
}

const g_lif_rg = {};
class lif_rg_rpc {
  constructor(){
    this.url = ws_origin()+'/.lif.rg';
  }
  async connect(){
    let rpc;
    if (rpc = g_lif_rg[this.url]){
      if (!rpc.error)
        return rpc;
      rpc.close();
    }
    rpc = g_lif_rg[this.url] = new rpc_websocket({D: 1});
    rpc.method('ping', ()=>({pong: 1}));
    rpc.method('version',
      ()=>({name: 'lif-coin-wallet', version: util_version}));
    try {
      await rpc.connect({url: this.url});
    } catch(e){
      console.error('roc_connect', e);
      rpc.close();
      throw e; // return
    }
    try {
      this.server_version = await rpc.T_call('version',
        {name: 'lif-coin-wallet', version: util_version});
    } catch(e){
      console.error('server version rpc', e);
      this.close();
      throw e; // XXX return
    }
    return rpc;
  }
  async call(method, params){
    let rpc = await this.connect();
    return await rpc.T_call(method, params);
  }
  close(){
    const rpc = g_lif_rg[this.url];
    if (rpc)
      rpc.close();
    delete g_lif_rg[this.url];
  }
  async topic_get(topic){
    return await this.call('topic_get', {topic});
  }
  async topic_pub(topic, data){
    return await this.call('topic_pub', {topic, data});
  }
  async topic_unpub(topic){
    return await this.call('topic_unpub', {topic});
  }
  async rcall(rg_id, method, params){
    return await this.call('rcall', {rg_id, method, params});
  }
  async rg_id(rg_id){
    return await this.call('rg_id', {rg_id});
  }
}

export function rg_rpc(){
  return new lif_rg_rpc();
}

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

// IndexedDB Cache
let db;
async function db_init(){
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
  for (const w of g_wallets){
    w.c = {};
    w.cs = {};
  }
}

const cache_ver = '2';
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
  c.balance = bals.reduce((s, b)=>s+b.confirmed+b.unconfirmed, 0);
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

export function hd_root(mnemonic, network, passphrase=''){
  return bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic, passphrase), network);
}
function wallet_root(wallet){
  const {ls, c, netconf} = wallet;
  if (c.root)
    return c.root;
  return c.root = hd_root(ls.mnemonic, netconf.network, ls.passphrase||'');
}

export function hd_path_def(netconf){
  return `m/84'/${netconf.coin_type}'/0'`;
}

export function hd_addr(network, root, accountPath, chain, index){
  const child = root.derivePath(`${accountPath}/${chain}/${index}`);
  const pubkey = child.publicKey;
  const {address} = bitcoin.payments.p2wpkh({pubkey, network});
  const keyPair = ecpair.fromPrivateKey(child.privateKey, {network});
  return {address, keyPair, chain, index};
}

export function hd_wallet(mnemonic, net_id, passphrase='', derivPath){
  const netconf = g_settings.netconf[net_id];
  const network = netconf.network;
  const root = hd_root(mnemonic, network, passphrase);
  const accountPath = derivPath || hd_path_def(netconf);
  const {address, keyPair} = hd_addr(network, root, accountPath, 0, 0);
  return {address, keyPair, network, netconf, root};
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

// convert address to scripthash (electrum usess scripthash for addresses)
export function addr_sh(saddr, network){
  const script = bitcoin.address.toOutputScript(saddr, network);
  const hash = sha256(script);
  return buf_to_hex(Buffer.from(hash.reverse()));
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

function kv_script(key, val){
  return bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN, Buffer.from('lif'),
    Buffer.from('key'),
    Buffer.from(key),
    Buffer.from('val'),
    Buffer.from(val),
  ]);
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

export function addr_valid(network, addr){
  try {
    bitcoin.address.toOutputScript(addr, network);
    return true;
  } catch(e){
    return false;
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

function tx_out_find(network, tx, saddr){
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
  if (fee==null){ // estimate fee: mock tx
    let {mock} = netconf;
    p.addInput({hash: mock.tx_hash, index: 0,
      witnessUtxo: {value: BigInt(_sum_out+1),
      script: bitcoin.address.toOutputScript(mock.address, network)}});
    let in_i = p.inputCount-1;
    p.addOutput({address: mock.address, value: 1n});
    p.signInput(in_i, mock.keyPair);
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
  in_sign = [...in_sign];
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
    in_sign.push(u);
  }
  if (sum_in<sum_out)
    return {err: "insufficient funds"};
  if (sum_in-sum_out>DUST_VAL){
    let chg = sum_in-sum_out; // add output to change
    p.addOutput({address: c.changeAddrInfo.address, value: BigInt(chg)});
  }
  for(let i=0; i<in_sign.length; i++)
    p.signInput(i, in_sign[i].addrInfo.keyPair);
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
  in_sign.push({addrInfo: addr});
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
  in_sign.push({addrInfo: addr});
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

export function mine_solo({netconf, saddr, min, max, target, steps=true}){
  return etask(function*()
{
  this.on('cancel', ()=>console.log('mine_solo canceled'));
  const el = _el(netconf);
  let template = yield el.mine_get_template(saddr);
  const header = buf_from_hex(template.header);
  console.log('starting mining', template.header);
  let reward = template.reward;
  let opt = {pow: netconf.pow, header, min, max, target};
  let mine_et = steps ? mine_steps(opt) : mine_worker_call(opt);
  mine_et.on('update', up=>this.emit('update', {...up, reward}));
  let mine_ret = yield mine_et;
  console.log('mine_res', mine_ret);
  if (!mine_ret.found)
    return {err: 'failed mining', ...mine_ret};
  console.log('submitting new block');
  mine_ret.header = buf_to_hex(mine_ret.header);
  let ret = yield el.mine_submit_header(mine_ret.header);
  if (!ret?.height)
    return {err: 'failed submitting new block', ...(ret||{})};
  console.log('success! new block height '+ret.height);
  return {...ret, reward};
}); }

let g_rg = {};
let g_rg_id = ''+Math.floor(Math.random()*1000000000);
export function mine_instant({netconf, saddr, target}){
  return etask(function*mine_instant()
{
  this.on('cancel', ()=>console.log('mine_instant canceled'));
  const rg_c = rg_rpc();
  let ret = yield rg_c.topic_get('mine_instant');
  if (!ret.length)
    return {err: 'no mining pools online'};
  let rg_id;
  for (let id of ret){
    if (g_rg[id]?.cheat)
      continue;
    ret = yield rg_c.rcall(id, 'ping');
    if (!ret.pong)
      continue;
    rg_id = id;
  }
  if (!rg_id)
    return {err: 'no good mining pools online'};
  let rg = g_rg[rg_id] ||= {template: 0, mined: 0, cheat: 0, success: 0};
  let template = yield rg_c.rcall(rg_id, 'mine_instant_get_template',
    {addr: saddr});
  if (template.error)
    return {err: 'pool: mine_instant_get_template '+template.error};
  if (!template.header)
    return {err: 'pool: no mine_instant_get_template'};
  let {reward, fee} = template;
  if (!reward || !fee)
    return {err: 'pool: no reward/fee'};
  let reward_net = reward-fee;
  if (reward_net<0)
    return {err: 'pool: reward lees than fee'};
  rg.template++;
  const header = buf_from_hex(template.header);
  let pay_target;
  if (target){
    // simulate real target
    const win_h = Number(target_to_nhash(target_from_compact(target)));
    const pay_h = Math.floor(win_h/template.nslice);
    pay_target = target_to_compact(target_from_nhash(pay_h));
  }
  let opt = {pow: netconf.pow, header, target: pay_target};
  let mine_et = mine_steps(opt);
  mine_et.on('update', up=>{
    this.emit('update', {...up, reward: reward_net});
    rg_c.rcall(rg_id, 'mine_instant_update', {mine_h: up.mine_h});
  });
  let mine_ret = yield mine_et;
  console.log('mine_res', mine_ret);
  if (!mine_ret.found)
    return mine_ret;
  rg.mined++;
  console.log('submitting new block');
  mine_ret.header = buf_to_hex(mine_ret.header);
  let tx_ret = yield rg_c.rcall(rg_id, 'mine_instant_submit', {header: mine_ret.header, addr: saddr});
  let tx = tx_ret?.tx;
  if (!tx){
    rg.cheat++;
    return {err: 'failed submitting winning share', ...(tx_ret||{}), cheat: 1};
  }
  let _tx = _try(()=>bitcoin.Transaction.fromHex(tx));
  if (!_tx){
    rg.cheat++;
    return {err: 'pool cheat: invalid tx', cheat: 1};
  }
  let out = tx_out_find(netconf.network, _tx, saddr);
  if (!out){
    rg.cheat++;
    return {err: 'pool cheat: didnt pay out to addr', cheat: 1};
  }
  let warn = {};
  reward_net = Number(out.value);
  if (reward_net<reward-fee){
    rg.cheat++;
    warn = {warn: 'pool cheat: paid only '+out.value+' - less than '
      +(reward-fee)+' promised (fee ', cheat: 1};
  }
  let txid = yield tx_broadcast(netconf, _tx);
  if (!txid){
    rg.cheat++;
    return {err: 'pool cheat: TX reward not accepted by mempool', cheat: 1};
  }
  rg.success++;
  console.log('success! new TX '+txid);
  return {txid, tx, _tx, reward_net, reward, fee, ...warn};
}); };

function header_match(a, b){
  let _a = buf_from_hex(a), _b = buf_from_hex(b);
  header_set_time(_a, 0);
  header_set_nonce(_a, 0);
  header_set_time(_b, 0);
  header_set_nonce(_b, 0);
  return buf_to_hex(_a)==buf_to_hex(_b);
}

let STALE_OFFER = 60; // 1 minute
export function mine_instant_pool({wallet, reward_share, target}){
  return etask(function*mine_instant_pool()
{
  this.on('cancel', ()=>console.log('mine_instant_pool canceled'));
  const {netconf} = wallet;
  const {pow} = netconf;
  const rg_c = rg_rpc();
  const rpc = yield rg_c.connect();
  const _this = this;
  let submit_err_n = 0, submit_err = '';
  let win_n = 0, pay_n = 0, win_v = 0, pay_v = 0;
  const offers = {};
  const nslice = 1024;
  const slice_sz = Math.floor(0x100000000/nslice);
  let total_h = 0;
  try {
    const el = _el(netconf);
    yield rg_c.rg_id(g_rg_id);
    const saddr = wallet.c.receiveAddress;
    const template = yield el.mine_get_template(saddr);
    const {reward} = template;
    const reward_net = Math.floor(reward*(1-reward_share));
    const header = buf_from_hex(template.header);
    target ||= header_get_target(header);
    const time_base = header_get_time(header);
    const time_base_local = date_time();
    const time_diff = time_base_local-time_base;
    const win_h = Number(target_to_nhash(target_from_compact(target)));
    const pay_h = Math.floor(win_h/nslice);
    const pay_target = target_to_compact(target_from_nhash(pay_h));
    const pay_reward = Math.floor(reward/nslice*reward_share);
    const fee = tx_send({wallet, saddr_to: wallet.c.changeAddrInfo.address,
      value: 1}).fee;
    let nwin = 0;
    let last_up = {now: Date.now(), total_h: 0};
    if (pay_reward<=fee)
      return {err: 'reward smaller than fees'};
    let do_update = ()=>{
      let now = Date.now();
      let hps = Math.floor((total_h-last_up.total_h)/
        Math.max(now-last_up.now, 1)*1000);
      this.emit('update', {hps, total_h, target, reward, reward_net,
        pay_target, pay_reward, pay_h, win_h, submit_err_n, submit_err,
        win_n, pay_n, win_v, pay_v});
      last_up = {now, total_h};
    };
    console.log('starting mining pool', template.header);
    do_update();
    // do here the pool mining
    rpc.method('mine_instant_get_template', params=>{
      let {addr} = params;
      if (!addr)
        return {err: 'no reward addr'};
      let offer;
      let i;
      for (let _i=0; _i<nslice; _i++){
        let offer = offers[_i];
        if (offer){
          if (date_time()-offer.last_update<STALE_OFFER)
            continue;
          delete offers[_i];
        }
        i = _i;
        break;
      }
      if (i==undefined)
        return {err: 'all offer slots full'};
      let now = date_time();
      let h = Buffer.from(header);
      let time_now = now-time_diff;
      header_set_time(h, time_now);
      offer = offers[i] = {min: i*slice_sz, max: (i+1)*slice_sz, addr,
        time_local: now, last_update: now, win: []};
      return {reward: pay_reward, fee, nslice,
        header: buf_to_hex(h), target: pay_target,
        min: offer.min, max: offer.max};
    });
    rpc.method('mine_instant_update', up=>{
      total_h += up.mine_h||0;
    });
    function mine_instant_submit(params){ return etask(function*(){
      let {addr, header: h, mine_h} = params;
      total_h += mine_h||0;
      if (!addr)
        return {err: 'no reward addr'};
      let _h = buf_from_hex(h);
      let nonce = header_get_nonce(_h);
      let time = header_get_time(_h);
      // check target full block winner
      let ret = mine({pow, header: _h, min: nonce, max: nonce+1, target});
      if (ret){
        console.log('seems like got a winning block!', h);
        let ret = yield el.mine_submit_header(h);
        if (ret?.height){
          console.log('winning block submitted successfully!');
          win_n++;
          win_v += reward;
          _this.emit('win', ret);
          do_update();
        }
      }
      // check target in range for reward - if so - give reward
      ret = mine({pow, header: _h, min: nonce, max: nonce+1,
        target: pay_target});
      if (!ret)
        return {err: 'pool cheat: not in target'};
      // locate offer, validate it matches nonce range and time range
      let i = Math.floor(nonce/slice_sz);
      let offer = offers[i];
      if (!offer)
        return {err: 'no offer for nonce range'};
      let win = offer.win.find(w=>w.time==time && w.nonce==nonce);
      if (win)
        return {err: 'offer was already presented'};
      win = {time, nonce, time_local: date_time(), header: h};
      if (!header_match(_h, header))
        return {err: 'header fields do not match offer'};
      let time_now = win.time_local-time_diff;
      if (time<time_base)
        return {err: 'header time too earlier than offer'};
      if (time>time_now+1)
        return {err: 'header time in the future'};
      console.log('valid offer - do share payout!');
      offer.win.push(win);
      nwin++;
      let tx = tx_send({wallet, saddr_to: addr, value: pay_reward-fee, fee});
      if (tx.err)
        return {err: 'failed payout to valid offer! serious bug!'};
      pay_n++;
      pay_v += pay_reward;
      _this.emit('pay', tx);
      do_update();
      ret = yield tx_broadcast(netconf, tx.tx);
      if (!ret)
        return {err: 'failed broadcast TX of payout to valid offer!'};
      return {result: {tx: tx.tx.toHex(), txid: tx.tx.getId(),
        reward: pay_reward-fee, fee, addr: addr}};
    }); }
    rpc._method('mine_instant_submit', async params=>{
      let ret = await mine_instant_submit(params);
      if (ret.error){
        console.error(ret.error);
        submit_err_n++;
        submit_err = ret.error;
        _this.emit('submit_err', ret);
        do_update();
      } else
        console.log(ret.result);
      do_update();
      return ret;
    });
    let ret = yield rg_c.topic_pub('mine_instant',
      {reward: pay_reward, fee, target});
    while (1){
      yield esleep(1000);
      do_update();
    }
  } catch(err){ CEA(err);
    return {err: ''+err};
  } finally {
    rpc.method('mine_instant_get_template');
    rpc.method('mine_instant_submit');
    yield rg_c.topic_unpub('mine_instant');
  }
}); }

