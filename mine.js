// LICENSE_CODE JPL mine.js - browser mining api
import sha256lif from 'lif-kernel/sha256lif.js';
import sha256 from 'lif-kernel/sha256.js';
import {ewait, esleep, assert, ipc_postmessage, date_time,
} from 'lif-kernel/util.js';
import etask from 'lif-kernel/etask.js';

let D = 0;

export function hash256_pow(pow, buf){
  if (pow=='sha256lif')
    return sha256lif.digest(sha256.digest(buf));
  if (pow=='sha256' || !pow)
    return sha256.digest(sha256.digest(buf));
  throw Error('invalid pow');
}

export function target_rcmp(a, b){
  assert(a.length===b.length);
  for (let i = a.length-1; i>=0; i--){
    if (a[i] < b[i])
      return -1;
    if (a[i] > b[i])
      return 1;
  }
  return 0;
}

export function target_from_compact(compact){
  compact = BigInt(compact);
  if (!compact)
    return 0n;
  const exponent = compact >> 24n;
  const negative = (compact >> 23n) & 1n;
  let mantissa = compact & 0x7fffffn;
  let num;
  if (exponent <= 3n){
    mantissa >>= 8n * (3n-exponent);
    num = mantissa;
  } else
    num = mantissa << 8n * (exponent-3n);
  if (negative)
    num = -num;
  return num;
}

function bigint_to_bytes(n){
  if (!n)
    return 0;
  return Math.ceil(n.toString(16).length/2);
}
export function target_to_compact(num){
  if (!num)
    return 0;
  let exponent = bigint_to_bytes(num);
  let mantissa;
  if (exponent <= 3){
    mantissa = Number(num);
    mantissa <<= 8 * (3 - exponent);
  } else
    mantissa = Number(num >> BigInt(8 * (exponent-3)));
  if (mantissa & 0x800000){
    mantissa >>= 8;
    exponent++;
  }
  let compact = (exponent << 24) | mantissa;
  if (num<0n)
    compact |= 0x800000;
  compact >>>= 0;
  return compact;
}

export function target_to_nhash(target){
  return (2n ** 256n)/target;
}

export function target_from_nhash(nhash){
  return (2n ** 256n)/BigInt(nhash);
}

export function bigint_to_buf_le(value, bytes){
  const a = new Buffer(bytes);
  for (let i=0; value>0n && i<32; i++){
    a[i] = Number(value & 0xFFn);
    value >>= 8n;
  }
  return a;
}

export function target_buf(bits){
  const target = target_from_compact(bits);
  if (target<0)
    throw new Error('Target is negative.');
  if (!target)
    throw new Error('Target is zero.');
  return bigint_to_buf_le(target, 32);
}

export function header_get_time(header){
  return header.readUInt32LE(68);
}
export function header_get_target(header){
  return header.readUInt32LE(72);
}
export function header_get_nonce(header){
  return header.readUInt32LE(76);
}
export function header_set_nonce(header, nonce){
  header.writeUInt32LE(nonce, 76);
}
export function header_set_time(header, time){
  header.writeUInt32LE(time, 68);
}

export function mine_single(pow, header, target_a, nonce){
  header_set_nonce(header, nonce);
  let hash = hash256_pow(pow, Buffer.from(header));
  if (target_rcmp(hash, target_a)<=0){
    D && console.log('mine_single: found nonce', nonce);
    return {found: true, nonce};
  }
}

export function mine({pow, header, min=0, max=0x100000000, target}){
  target ||= header_get_target(header);
  let target_a = target_buf(target);
  let v;
  for (let i=min; i<max; i++){
    if (v=mine_single(pow, header, target_a, i))
      return {...v, header};
  }
}

let mine_worker;
let mine_worker_wait;
let mine_ipc;
export function mine_worker_init(){ return etask(function*(){
  if (mine_worker_wait)
    return yield mine_worker_wait;
  mine_worker_wait = ewait('mine_worker');
  console.log('mine_worker_init.js');
  mine_worker = new Worker(import.meta.resolve('./mine_worker_init.js'),
    {type: 'module'});
  mine_ipc = new ipc_postmessage();
  mine_ipc.connect(mine_worker);
  let v = yield mine_ipc.T_call('version');
  console.log('connected to mine_worker version', v);
  return mine_worker_wait.return(mine_ipc);
}); }

export function mine_worker_call(mine_cmd){ return etask(function*(){
  let mine_ipc = yield mine_worker_init();
  let opt = {...mine_cmd};
  opt.header = opt.header.toString('hex');
  let ret = yield mine_ipc.T_call('mine', opt);
  console.log('got ret', ret);
  if (ret.header)
    ret.header = Buffer.from(ret.header, 'hex');
  return ret;
}); }

export function mine_stats_calc({hps, target, reward}){
  let win_h = Number(target_to_nhash(target_from_compact(target)));
  let win_time = hps ? Math.floor(win_h/hps) : 0;
  let earn_hour = Math.floor(hps*60*60/win_h*reward);
  return {win_h, win_time, earn_hour};
}

export function mine_steps({pow, header, time_local,
  min=0, max=0x100000000, target}){ return etask(function*()
{
  this.on('cancel', ()=>console.log('mine_steps canceled'));
  let hps = 10000; // initial hashs per second. Android ~60,000, PC ~100,000
  let slice_ms = 1000;
  let total_h = 0;
  let mine_h = 0;
  let at = min;
  time_local ||= date_time();
  let time_diff = header_get_time(header)-time_local;
  let time_last = time_local;
  let _header = Buffer.from(header);
  target ||= header_get_target(header);
  for (;;){
    let step_h = Math.max(Math.floor(hps*slice_ms/1000), 1000);
    this.emit('update', {hps, total_h, target, mine_h});
    mine_h = 0;
    let time = date_time();
    if (time!=time_last){
      header_set_time(_header, time+time_diff);
      time_last = time;
      at = min;
    }
    let tstart = Date.now();
    let ret = yield mine_worker_call({pow, header: _header, target,
      min: at, max: Math.min(at+step_h, 0x100000000)});
    if (ret.found){
      mine_h += ret.nonce-at;
      total_h += ret.nonce-at;
      return {...ret, total_h};
    }
    mine_h += step_h;
    total_h += step_h;
    let tend = Date.now();
    let ms = Math.max(tend-tstart, 1);
    hps = Math.round(step_h*1000/ms);
    at += step_h;
    if (at>=max){
      console.warn('mine reached nonce end of slice');
      yield esleep(slice_ms);
    }
  }
  return {found: false, total_h};
}); }

function test(){
  let t;
  t = (compact, target, buf, nhash)=>{
    assert.eq(target_from_compact(compact), target);
    assert.eq(target_to_compact(target), compact);
    assert.eq(bigint_to_buf_le(target, 32).toString('hex'), buf);
    assert.eq(target_buf(compact).toString('hex'), buf);
    assert.eq(target_to_nhash(target), nhash);
  };
  t(0x1d00ffff, 
    0x00000000ffff0000000000000000000000000000000000000000000000000000n,
    '0000000000000000000000000000000000000000000000000000ffff00000000',
    4295032833n);
  t(0x1f00ffff,
    0x0000ffff00000000000000000000000000000000000000000000000000000000n,
    '00000000000000000000000000000000000000000000000000000000ffff0000',
    65537n);
  t = (header, pow, min, max, v)=>assert.eq(mine(
    {pow, header: Buffer.from(header, 'hex'), min, max})?.nonce, v);
  let header = '00000020d7da75d79cff74f6a9896d6445a4abb9d283cfb5df37bdcc8d886bfdd441000085ea5bf430856f0ba4e80515b9fc45bf8ef837a2da8c5b8ab1fadc5f6b7c37d5fabbee69ffff001ff52d0100';
  t(header, 'sha256lif', 77290, 77310, 77301);
  t(header, 'sha256lif', 77302, 77310, undefined);
  t(header, 'sha256', 53830, 53850, 53840);
  t(header, 'sha256', 53841, 53850, undefined);
}
test();

