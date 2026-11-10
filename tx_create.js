// tx_create.js - TX creation, fee estimation, broadcast
import * as bitcoin from 'bitcoinjs-lib';
import {DUST_VAL, hd_addr, addr_sh} from './settings.js';
import {_el} from './electrum.js';
import {tx_put, sh_history_get, sh_history_put} from './db_util.js';

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
  // Store TX locally as mempool entry
  let raw = tx.toHex();
  await tx_put(txid, {txid, raw, height: 0, verified: false});
  // Add to scripthash histories for all output addresses
  let network = netconf.network;
  for (let out of tx.outs){
    let addr;
    try { addr = bitcoin.address.fromOutputScript(out.script, network); }
    catch(e){ continue; }
    let sh = addr_sh(addr, network);
    let cached = await sh_history_get(sh);
    if (!cached)
      continue;
    let entries = cached.entries || [];
    if (!entries.some(e=>e.tx_hash==txid))
    {
      entries.push({tx_hash: txid, height: 0});
      await sh_history_put(sh, {...cached, entries});
    }
  }
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
