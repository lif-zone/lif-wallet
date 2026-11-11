// settings.js - shared wallet settings, network configs, HD helpers
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import ecc from '@bitcoinerlab/secp256k1';
import {BIP32Factory} from 'bip32';
const bip32 = BIP32Factory(ecc);
import {ECPairFactory} from 'ecpair';
const ecpair = ECPairFactory(ecc);
import {T, OE, OV, OA, lif_url_tr} from 'lif-kernel/util.js';
import {db_get, db_put, cache_ver} from './db_util.js';

const sha256 = bitcoin.crypto.sha256;

export function buf_from_hex(b){
  if (Buffer.isBuffer(b))
    return Buffer.from(b);
  return Buffer.from(b, 'hex');
}
export function buf_to_hex(b){
  b = Buffer.from(b);
  return b.toString('hex');
}
export const HD_SCAN_GAP = 20;
export const DUST_VAL = 1;

// add Lif network, from lif-coin/lib/protocol/networks.js
let networks_lif = {
  bech32: 'lif',
  bip32: {
    public: 0x5d6413db,
    private: 0x5d631e9c,
  },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  genesisHash: '00000000e05445185102cd4c86f0b7bad830cff86eb52c916b0fe1fbea4b7c6b',
};
let networks_liftest = {
  bech32: 'liftest',
  bip32: {
    public: 0x5d6413db,
    private: 0x5d631e9c,
  },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  genesisHash: '7c1609d00e5371d7eb590346659b1e901040013c41b5cbcff3d0f1c1bf318542',
};

export const netconf_def = {
  lif: {
    name: 'Lifcoin', // Life Chai
    symbol: 'LIF',
    network: networks_lif,
    electrum: 'lif:net/lifcoin/electrum',
    //electrum: '/.lif.net/electrum',
    //electrum: '/.lif.net/electrum-proxy',
    explorer_tx: lif_url_tr('http://explorer.lif/tx/'),
    coin_type: 1842,
    fee_def: 5000000, // 1MB = 50LIF
    lif_kv: true,
    pow: 'sha256lif',
    pow_hps: 50000, // Hash/Sec: android ~60,000 hps, Desktop ~100,000 hps
    usd: 0.01,
  },
  liftest: {
    name: 'Lifcoin Testnet',
    symbol: 'tLIF',
    network: networks_liftest,
    electrum: 'lif:net/lifcoin_test/electrum',
    //electrum: '/.lif.net/electrum_test',
    explorer_tx: lif_url_tr('https://explorer.lif/tx/'),
    coin_type: 1,
    fee_def: 5000000, // 1MB = 50LIF
    lif_kv: true,
    pow: 'sha256lif',
    pow_hps: 50000, // Hash/Sec: android ~60,000 hps, Desktop ~100,000 hps
    test: true,
    usd: 0.01,
  },
  btc: {
    name: 'Bitcoin',
    symbol: 'BTC',
    network: {...bitcoin.networks.bitcoin,
      genesisHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'},
    electrum: 'lif:net/bitcoin/electrum',
    //electrum: 'wss://bitcoinserver.nl:50004', // unrestricted
    //electrum: 'wss://electrumx.nimiq.com:443/electrumx', // restricted from localhost:5000
    //electrum: 'wss://electrum.blockstream.info:700', // does not work
    //electrum: 'tcp:electrum1.bluewallet.io:50001', // untested
    //electrum: 'ssl:electrum1.bluewallet.io:443', // untested
    explorer_tx: 'https://mempool.space/tx/',
    coin_type: 0,
    fee_def: 1000, // 1MB = 0.01BTC
    usd: 50000,
  },
  btc_testnet: {
    name: 'Bitcoin Testnet',
    symbol: 'tBTC',
    network: {...bitcoin.networks.testnet,
      genesisHash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'},
    electrum: 'lif:net/bitcoin_test/electrum',
    //electrum: 'wss://electrum.blockstream.info:993',
    explorer_tx: 'https://mempool.space/testnet/tx/',
    coin_type: 1,
    fee_def: 1000,
    test: true,
    usd: 0.01,
  },
};

export const LIF_SERVER_DEF = 'http://localhost:8432';

export const g_settings = {};

async function get_btc_usd(){
  const [cg, binance, cb] = await Promise.all([
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd').then(r=>r.json()),
    fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(r=>r.json()),
    fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker').then(r=>r.json())
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

export async function settings_cs_load(){
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

export async function settings_load(){
  g_settings.ls = T(()=>JSON.parse(localStorage.getItem('settings'))) || {};
  const s = g_settings;
  const {ls} = g_settings;
  ls.lif_server ||= LIF_SERVER_DEF;
  ls.devtools = !! ls.devtools;
  ls.full_spv = ls.full_spv ?? true;
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

// convert address to scripthash (electrum uses scripthash for addresses)
export function addr_sh(saddr, network){
  const script = bitcoin.address.toOutputScript(saddr, network);
  const hash = sha256(script);
  return buf_to_hex(hash.reverse());
}

export function hd_root(mnemonic, network, passphrase=''){
  return bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic, passphrase),
    network);
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

export function hd_xpub(mnemonic, network, passphrase='', accountPath){
  const root = hd_root(mnemonic, network, passphrase);
  return root.derivePath(accountPath).neutered().toBase58();
}

// Parse extended public key (xpub/zpub/ypub) with flexible version handling
export function parse_xpub(xpub_str, network){
  // Try with network's native bip32 versions
  try { return bip32.fromBase58(xpub_str, network); }
  catch(e){}
  // Try known extended key versions
  const versions = [
    {bip32: {public: 0x0488B21E, private: 0x0488ADE4}}, // xpub
    {bip32: {public: 0x04b24746, private: 0x04b2430c}}, // zpub
    {bip32: {public: 0x049d7cb2, private: 0x049d7878}}, // ypub
    {bip32: {public: 0x045f1cf6, private: 0x045f18bc}}, // vpub (testnet zpub)
    {bip32: {public: 0x043587CF, private: 0x04358394}}, // tpub
    {bip32: {public: 0x5d6413db, private: 0x5d631e9c}}, // Lpub (LIF)
  ];
  for (let v of versions){
    try { return bip32.fromBase58(xpub_str, v); }
    catch(e){}
  }
  throw new Error('Invalid extended public key');
}

export function xpub_derive_addr(network, node, chain, index){
  let child = node.derive(chain).derive(index);
  let {address} = bitcoin.payments.p2wpkh({pubkey: child.publicKey, network});
  return {address, chain, index};
}

export function addr_valid(network, addr){
  try {
    bitcoin.address.toOutputScript(addr, network);
    return true;
  } catch(e){
    return false;
  }
}
