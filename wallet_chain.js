// wallet_chain.js - SPV header chain store and validation
import {buf_from_hex, buf_to_hex} from './settings.js';
import {_el} from './electrum.js';
import {hash256_pow, target_buf, target_rcmp} from './mine.js';
import {hdr_get, hdr_put, hdr_get_tip, tx_get, tx_put,
  sh_history_get, sh_history_put} from './db_util.js';

const HEADERS_FORWARD = 6;
const HEADERS_BACKWARD = 100;
const HEADER_SIZE = 80;

// Parse 80-byte raw header buffer into fields
function hdr_parse(raw_hex, height){
  let buf = buf_from_hex(raw_hex);
  if (buf.length!=HEADER_SIZE)
    throw new Error('invalid header size: '+buf.length);
  let version = buf.readInt32LE(0);
  let prevHash = buf_to_hex(Buffer.from(buf.slice(4, 36)).reverse());
  let merkleRoot = buf_to_hex(Buffer.from(buf.slice(36, 68)).reverse());
  let time = buf.readUInt32LE(68);
  let bits = buf.readUInt32LE(72);
  let nonce = buf.readUInt32LE(76);
  return {height, version, prevHash, merkleRoot, time, bits, nonce,
    raw: raw_hex};
}

// Compute block hash from raw header hex using the network's PoW function
function hdr_hash(raw_hex, pow){
  let buf = buf_from_hex(raw_hex);
  let hash = hash256_pow(pow, buf);
  return buf_to_hex(Buffer.from(hash).reverse());
}

// Validate PoW: hash must be <= target derived from bits
function hdr_verify_pow(raw_hex, pow){
  let buf = buf_from_hex(raw_hex);
  let bits = buf.readUInt32LE(72);
  let hash = hash256_pow(pow, buf);
  let target = target_buf(bits);
  return target_rcmp(hash, target)<=0;
}

// State per network
const chain_state = {};

function get_state(netconf){
  let key = netconf.symbol;
  if (!chain_state[key])
    chain_state[key] = {tip: null, netconf};
  return chain_state[key];
}

// Load tip from DB on init
export async function wc_init(netconf){
  let st = get_state(netconf);
  st.tip = await hdr_get_tip();
  if (st.tip)
    st.tip.hash = hdr_hash(st.tip.raw, netconf.pow);
  return st;
}

// Sync headers from electrum. Fetches from current tip to chain tip.
export async function wc_sync_headers(netconf){
  let st = get_state(netconf);
  let el = _el(netconf);
  let sub = await el.headers_subscribe();
  if (sub.error)
    return {error: sub.error};
  let chain_height = sub.height;
  let start = st.tip ? st.tip.height+1 : 0;
  let pow = netconf.pow;
  let count = 0;
  for (let h=start; h<=chain_height; h++){
    let raw_hex = await el.block_header(h);
    if (raw_hex.error)
      return {error: 'block_header '+h+': '+raw_hex.error};
    let hdr = hdr_parse(raw_hex, h);
    hdr.hash = hdr_hash(raw_hex, pow);
    if (!hdr_verify_pow(raw_hex, pow))
      return {error: 'invalid pow at height '+h};
    if (st.tip && hdr.prevHash!=st.tip.hash)
      return {error: 'prevHash mismatch at height '+h};
    await hdr_put(h, hdr);
    st.tip = hdr;
    count++;
    if (count%100==0)
      console.log('wc_sync_headers: '+h+'/'+chain_height);
  }
  if (count)
    console.log('wc_sync_headers: synced '+count+' headers to '+chain_height);
  return {height: chain_height, count};
}

// Get a stored header by height
export async function wc_get_header(height){
  return await hdr_get(height);
}

// Step 2: TX store with merkle proofs

// Compute merkle root from txid + proof path + position
function merkle_root_from_proof(pow, txid, merkle, pos){
  let hash = buf_from_hex(txid).reverse();
  for (let sibling of merkle){
    let s = buf_from_hex(sibling).reverse();
    hash = hash256_pow(pow, Buffer.concat(pos&1 ? [s, hash] : [hash, s]));
    pos >>= 1;
  }
  return buf_to_hex(Buffer.from(hash).reverse());
}

// Fetch TX + merkle proof from electrum, verify against stored header, store
export async function wc_store_tx(netconf, txid, height){
  let el = _el(netconf);
  let raw = await el.tx_get(txid, false);
  if (raw?.error)
    return {error: 'tx_get '+txid+': '+raw.error};
  let merkle_res = await el.tx_get_merkle(txid, height);
  if (merkle_res?.error)
    return {error: 'tx_get_merkle '+txid+': '+merkle_res.error};
  let {merkle, pos} = merkle_res;
  let computed_root = merkle_root_from_proof(netconf.pow, txid, merkle, pos);
  let hdr = await hdr_get(height);
  let verified = false;
  if (hdr && hdr.merkleRoot==computed_root)
    verified = true;
  let entry = {txid, raw, height, merkle, pos, verified};
  await tx_put(txid, entry);
  return entry;
}

// Verify a stored TX against its header (e.g. after syncing new headers)
export async function wc_verify_tx(netconf, txid){
  let entry = await tx_get(txid);
  if (!entry)
    return {error: 'tx not found'};
  let hdr = await hdr_get(entry.height);
  if (!hdr)
    return {error: 'header not found at height '+entry.height};
  let computed_root = merkle_root_from_proof(netconf.pow, txid, entry.merkle,
    entry.pos);
  entry.verified = hdr.merkleRoot==computed_root;
  await tx_put(txid, entry);
  return entry;
}

// Fetch and store scripthash history from electrum
export async function wc_sync_sh_history(netconf, sh){
  let el = _el(netconf);
  let history = await el.sh_get_history(sh);
  if (history?.error)
    return {error: 'sh_get_history: '+history.error};
  await sh_history_put(sh, history);
  return history;
}

// Get stored scripthash history
export async function wc_get_sh_history(sh){
  return await sh_history_get(sh);
}

// Get stored TX
export async function wc_get_tx(txid){
  return await tx_get(txid);
}

export {HEADERS_FORWARD, HEADERS_BACKWARD};
