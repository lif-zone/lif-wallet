// wallet_chain.js - SPV header chain store and validation
import * as bitcoin from 'bitcoinjs-lib';
import {buf_from_hex, buf_to_hex, addr_sh, HD_SCAN_GAP,
  hd_addr} from './settings.js';
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
  st.tip = await hdr_get_tip(netconf.symbol);
  if (st.tip)
    st.tip.hash = hdr_hash(st.tip.raw, netconf.pow);
  return st;
}

const BATCH_SIZE = 2016;

// Merge overlapping/adjacent [from, to] ranges (sorted by from)
function merge_ranges(ranges){
  if (!ranges.length)
    return [];
  ranges.sort((a, b)=>a[0]-b[0]);
  let merged = [ranges[0]];
  for (let i=1; i<ranges.length; i++){
    let last = merged[merged.length-1];
    if (ranges[i][0]<=last[1]+1)
      last[1] = Math.max(last[1], ranges[i][1]);
    else
      merged.push(ranges[i]);
  }
  return merged;
}

// Sync headers around TX heights. Only fetches what's missing from DB.
export async function wc_sync_headers(netconf, tx_heights, chain_height){
  let net = netconf.symbol;
  let el = _el(netconf);
  if (!tx_heights?.length)
    return {height: chain_height, count: 0};
  // Compute needed ranges from TX heights
  let ranges = tx_heights.map(h=>[
    Math.max(0, h-HEADERS_BACKWARD),
    Math.min(chain_height, h+HEADERS_FORWARD),
  ]);
  ranges = merge_ranges(ranges);
  // Remove heights we already have
  let missing = [];
  for (let [from, to] of ranges){
    let run_start = null;
    for (let h=from; h<=to; h++){
      let existing = await hdr_get(net, h);
      if (!existing){
        if (run_start==null)
          run_start = h;
      } else {
        if (run_start!=null){
          missing.push([run_start, h-1]);
          run_start = null;
        }
      }
    }
    if (run_start!=null)
      missing.push([run_start, to]);
  }
  if (!missing.length)
    return {height: chain_height, count: 0};
  // Fetch missing ranges in batches
  let pow = netconf.pow;
  let total = 0;
  for (let [from, to] of missing){
    let start = from;
    while (start<=to){
      let want = Math.min(BATCH_SIZE, to-start+1);
      let res = await el.block_headers(start, want);
      if (res.error)
        return {error: 'block_headers '+start+': '+res.error};
      let {hex, count} = res;
      if (!count)
        break;
      for (let i=0; i<count; i++){
        let raw_hex = hex.slice(i*HEADER_SIZE*2, (i+1)*HEADER_SIZE*2);
        let h = start+i;
        let hdr = hdr_parse(raw_hex, h);
        hdr.hash = hdr_hash(raw_hex, pow);
        if (!hdr_verify_pow(raw_hex, pow))
          return {error: 'invalid pow at height '+h};
        // Validate prevHash against previous header if we have it
        let prev = await hdr_get(net, h-1);
        if (prev){
          let prev_hash = hdr_hash(prev.raw, pow);
          if (hdr.prevHash!=prev_hash)
            return {error: 'prevHash mismatch at height '+h};
        }
        await hdr_put(net, h, hdr);
        total++;
      }
      start += count;
    }
  }
  if (total)
    console.log('wc_sync_headers: synced '+total+' headers for '+net);
  return {height: chain_height, count: total};
}

// Get a stored header by height
export async function wc_get_header(netconf, height){
  return await hdr_get(netconf.symbol, height);
}

// Step 2: TX store with merkle proofs

// Compute merkle root from txid + proof path + position
// Merkle trees always use double-SHA256 (like bitcoin), not the PoW hash
function merkle_root_from_proof(txid, merkle, pos){
  let hash = buf_from_hex(txid).reverse();
  for (let sibling of merkle){
    let s = buf_from_hex(sibling).reverse();
    hash = hash256_pow('sha256', Buffer.concat(pos&1 ? [s, hash] : [hash, s]));
    pos >>= 1;
  }
  return buf_to_hex(Buffer.from(hash).reverse());
}

// Fetch TX + merkle proof + verbose from electrum, store all. Cache-first.
export async function wc_store_tx(netconf, txid, height){
  let existing = await tx_get(txid);
  if (existing)
    return existing;
  let el = _el(netconf);
  let [raw, verbose, merkle_res] = await Promise.all([
    el.tx_get(txid, false),
    el.tx_get(txid, true),
    el.tx_get_merkle(txid, height),
  ]);
  if (raw?.error)
    return {error: 'tx_get '+txid+': '+raw.error};
  if (merkle_res?.error)
    return {error: 'tx_get_merkle '+txid+': '+merkle_res.error};
  // Verify raw TX hashes to claimed txid
  let tx = bitcoin.Transaction.fromHex(raw);
  if (tx.getId()!=txid)
  {
    console.warn('wc_store_tx: electrum server returned TX with wrong txid',
      txid, tx.getId());
    return {error: 'txid mismatch'};
  }
  let {merkle, pos} = merkle_res;
  let computed_root = merkle_root_from_proof(txid, merkle, pos);
  // Check if root matches our header (may not match during reorg — that's ok)
  let hdr = await hdr_get(netconf.symbol, height);
  let verified = !!(hdr && hdr.merkleRoot==computed_root);
  let entry = {txid, raw, verbose, height, merkle, pos, merkle_root:
    computed_root, verified};
  await tx_put(txid, entry);
  return entry;
}

// Get verbose TX — local first, fetch+store if missing
export async function wc_tx_get_verbose(netconf, txid){
  let entry = await tx_get(txid);
  if (entry?.verbose)
    return entry.verbose;
  let el = _el(netconf);
  let verbose = await el.tx_get(txid, true);
  if (verbose?.error)
    return verbose;
  if (entry){
    entry.verbose = verbose;
    await tx_put(txid, entry);
  }
  return verbose;
}

// Verify a stored TX against its header (e.g. after syncing new headers)
export async function wc_verify_tx(netconf, txid){
  let entry = await tx_get(txid);
  if (!entry)
    return {error: 'tx not found'};
  let hdr = await hdr_get(netconf.symbol, entry.height);
  if (!hdr)
    return {error: 'header not found at height '+entry.height};
  let root = entry.merkle_root
    || merkle_root_from_proof(txid, entry.merkle, entry.pos);
  entry.merkle_root = root;
  entry.verified = hdr.merkleRoot==root;
  await tx_put(txid, entry);
  return entry;
}

// Get stored TX
export async function wc_get_tx(txid){
  return await tx_get(txid);
}

// Step 5: wc versions of wallet_db functions

// Fetch sh history from electrum if stale (checked_height < chain_height)
// refresh=true ignores checked_height, always re-queries
async function sh_history_fetch(netconf, sh, chain_height, refresh){
  let cached = await sh_history_get(sh);
  if (cached && !refresh && cached.checked_height>=chain_height)
    return cached.entries;
  let el = _el(netconf);
  let history = await el.sh_get_history(sh);
  if (history?.error)
    return cached?.entries || [];
  await sh_history_put(sh, {entries: history, checked_height: chain_height});
  return history;
}

// HD scan — cache-first, fetches from electrum only what's missing
// refresh=true: re-query all address histories ignoring cached height
export async function wc_hd_scan(netconf, root, accountPath, chain,
  chain_height, refresh)
{
  let network = netconf.network;
  let used = [];
  let lastUsed = -1;
  let start = 0;
  while (true){
    let entries = Array.from({length: HD_SCAN_GAP},
      (_, i)=>hd_addr(network, root, accountPath, chain, start+i));
    let hists = await Promise.all(entries.map(e=>
      sh_history_fetch(netconf, addr_sh(e.address, network),
        chain_height, refresh)));
    let anyUsed = false;
    let tx_fetches = [];
    for (let i=0; i<HD_SCAN_GAP; i++){
      let hist = hists[i];
      if (!hist?.length)
        continue;
      for (let h of hist){
        if (h.height>0)
          tx_fetches.push(h);
      }
      used.push({...entries[i], hist});
      lastUsed = entries[i].index;
      anyUsed = true;
    }
    // Fetch missing TXs in parallel (wc_store_tx is cache-first)
    await Promise.all(tx_fetches.map(h=>
      wc_store_tx(netconf, h.tx_hash, h.height)));
    if (!anyUsed)
      break;
    start += HD_SCAN_GAP;
  }
  return {used, nextIndex: lastUsed+1};
}

// Step 3: UTXO + balance from local DB

// Parse raw tx hex, extract output addresses
function tx_parse_outputs(raw_hex, network){
  let tx = bitcoin.Transaction.fromHex(raw_hex);
  let outputs = [];
  for (let i=0; i<tx.outs.length; i++){
    let addr;
    try {
      addr = bitcoin.address.fromOutputScript(tx.outs[i].script, network);
    } catch(e){}
    outputs.push({index: i, value: Number(tx.outs[i].value), address: addr});
  }
  return {txid: tx.getId(), outputs, inputs: tx.ins.map(inp=>({
    txid: Buffer.from(inp.hash).reverse().toString('hex'),
    vout: inp.index,
  }))};
}

function sh_entries(cached){
  if (!cached)
    return [];
  return cached.entries || cached;
}

// Compute balance from locally stored TXs for a set of addresses
export async function wc_get_balance(netconf, addrs){
  let network = netconf.network;
  let addr_set = new Set(addrs.map(a=>a.address));
  let spent = new Set();
  let confirmed = 0;
  let unconfirmed = 0;
  // Collect all TXs from scripthash histories
  let tx_entries = [];
  for (let a of addrs){
    let sh = addr_sh(a.address, network);
    let hist = sh_entries(await sh_history_get(sh));
    if (!hist.length)
      continue;
    for (let h of hist){
      let entry = await tx_get(h.tx_hash);
      if (entry)
        tx_entries.push({entry, height: h.height});
    }
  }
  // Mark spent outputs
  for (let {entry} of tx_entries){
    let parsed = tx_parse_outputs(entry.raw, network);
    for (let inp of parsed.inputs)
      spent.add(inp.txid+':'+inp.vout);
  }
  // Sum unspent outputs belonging to our addresses
  for (let {entry, height} of tx_entries){
    let parsed = tx_parse_outputs(entry.raw, network);
    for (let out of parsed.outputs){
      if (!addr_set.has(out.address))
        continue;
      if (spent.has(entry.txid+':'+out.index))
        continue;
      if (height>0)
        confirmed += out.value;
      else
        unconfirmed += out.value;
    }
  }
  return {confirmed, unconfirmed};
}

// List unspent outputs from locally stored TXs for a set of addresses
export async function wc_listunspent(netconf, addrs){
  let network = netconf.network;
  let addr_set = new Set(addrs.map(a=>a.address));
  let spent = new Set();
  let tx_entries = [];
  for (let a of addrs){
    let sh = addr_sh(a.address, network);
    let hist = sh_entries(await sh_history_get(sh));
    if (!hist.length)
      continue;
    for (let h of hist){
      let entry = await tx_get(h.tx_hash);
      if (entry)
        tx_entries.push({entry, height: h.height});
    }
  }
  for (let {entry} of tx_entries){
    let parsed = tx_parse_outputs(entry.raw, network);
    for (let inp of parsed.inputs)
      spent.add(inp.txid+':'+inp.vout);
  }
  let unspent = [];
  for (let {entry, height} of tx_entries){
    let parsed = tx_parse_outputs(entry.raw, network);
    for (let out of parsed.outputs){
      if (!addr_set.has(out.address))
        continue;
      if (spent.has(entry.txid+':'+out.index))
        continue;
      let a = addrs.find(a=>a.address==out.address);
      unspent.push({tx_hash: entry.txid, tx_pos: out.index, value: out.value,
        height, address: out.address, chain: a?.chain, index: a?.index});
    }
  }
  return unspent;
}

export {HEADERS_FORWARD, HEADERS_BACKWARD};
