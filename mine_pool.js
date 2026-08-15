import {_try, date_time, CEL, ewait, assert} from 'lif-kernel/util.js';
import etask from 'lif-kernel/etask.js';
import {lifnet_online, lifnet_connect, lifnet_listen} from 'lif-kernel/lifnet';
import {_el, buf_from_hex, buf_to_hex} from './wallet_db.js';
import * as bitcoin from 'bitcoinjs-lib';
import {mine, mine_worker_call, mine_steps,
  hash256_pow, target_from_nhash, target_to_nhash, target_to_compact,
  header_get_target, header_get_time, header_set_time,
  header_get_nonce, header_set_nonce, target_from_compact,
} from './mine.js';
import {tx_out_find, tx_broadcast, tx_send} from './wallet_db.js';

export function mine_solo({netconf, saddr, min, max, target, steps=true}){
  return etask(function*()
{
  const el = _el(netconf);
  let template = yield el.mine_get_template(saddr);
  const header = buf_from_hex(template.header);
  console.log('starting mining', template.header);
  let reward = template.reward;
  let opt = {pow: netconf.pow, header, min, max, target};
  let mine_et =
    steps && mine_slave_enable.includes('remote') ? mine_slave(opt) :
    steps && mine_slave_enable.includes('alt') ? mine_steps_alt(opt) :
    steps ? mine_steps(opt) :
    mine_worker_call(opt);
  mine_et.on('update', up=>this.emit('update', {...up, reward}));
  let mine_ret = yield mine_et;
  console.log('mine_res', mine_ret);
  if (!mine_ret.found)
    return {err: 'failed mining', ...mine_ret};
  console.log('submitting new block');
  mine_ret.header = buf_to_hex(mine_ret.header);
  let ret = yield el.mine_submit_header(mine_ret.header);
  console.log('mine_submit res', ret);
  if (!ret?.height)
    return {err: 'failed submitting new block', ...(ret||{})};
  console.log('success! new block height '+ret.height);
  return {...ret, reward};
}); }

function header_match(a, b){
  let _a = buf_from_hex(a), _b = buf_from_hex(b);
  header_set_time(_a, 0);
  header_set_nonce(_a, 0);
  header_set_time(_b, 0);
  header_set_nonce(_b, 0);
  return buf_to_hex(_a)==buf_to_hex(_b);
}

function mine_steps_alt({pow, header, target, min, max}){
  return etask(function*(et)
{
  let be = yield import('https://bright.life/lif-wallet/alt.js');
  let orig_header = buf_to_hex(header);
  target ||= header_get_target(header);
  let target_n = target_from_compact(target);
  let last = Date.now();
  pow ||= 'sha256lif';
  assert(pow=='sha256lif');
  let up = {hps: 0, total_h: 0, mine_h: 0, target};
  let events = {
    onProgress(step){
      up.total_h += step;
      up.mine_h = step;
      let now = Date.now();
      up.hps = Math.round(step/Math.max(now-last, 1)*1000);
      last = now;
      console.log('step', step);
      et.emit('update', up);
    },
    onComplete(res){ return etask(function*(){
      let {nonce, time, header: s_header, checksum, mask} = res;
      be.stop();
      console.log('mask found! nonce '+nonce+' time '+time);
      console.log('header '+s_header);
      console.log('checksum '+checksum);
      console.log('nonce '+nonce.toString(16));
      let b_header = buf_from_hex(s_header);
      let _checksum = buf_to_hex(hash256_pow(pow, b_header));
      assert(checksum==_checksum,
        'invalid checksum mismatch: calc '+_checksum+' got '+checksum);
      // do accurate comparison to target, not just simple bit-mask zero bits
      let ret = mine({pow, header: b_header, min: nonce, max: nonce+1, target});
      if (!ret){
        console.log('target not good enough.');
        console.log('mask:     '+mask);
        console.log('chehksum: '+checksum);
        let target_s = target_from_compact(target).toString(16).padStart(64, 0);
        console.log('target:   '+target_s);
        yield etask.sleep(1000); // make sure time passes
        be.start();
        return;
      }
      console.log('found approved win!');
      et.return({found: true, header: b_header, nonce, time});
    }); },
    onError(error){
      console.error(error);
      et.return({error});
    },
  };
  if (!be.init(events))
    return {error: 'failed be.init'};
  be.setLoadRate(1);
  be.start({header, target_n});
  et.on('finally', ()=>be.stop());
  return etask.wait();
}); }

let mine_slave_et;
export function mine_slave_listen(){ return etask(function*(_et){
  let win_n = 0;
  let listen = lifnet_listen({topic: 'lifcoin/mine_slave'}, ({msg, sock})=>{
    let {header: header_hex, target, min, max, pow} = msg.params;
    if (pow!='sha256lif')
      return {error: 'invalid pow'};
    if (!header_hex)
      return {error: 'no header'};
    if (mine_slave_et)
      return {error: 'busy'};
    const header = buf_from_hex(header_hex);
    let et = mine_slave_et = etask(function*(et){
      et.on('finally', ()=>sock.close());
      let mine_et = mine_slave_enable.includes('alt') ? 
        mine_steps_alt({pow, header, target, min, max}) :
        mine_steps({pow, header, target, min, max});
      mine_et.on('update', up=>sock.notify('update', up));
      mine_et.on('update', up=>_et.emit('update', {win_n, ...up}));
      let ret = yield mine_et;
      if (!ret?.found){
        sock.notify('not_found', {total_h: ret?.total_h});
        return;
      }
      win_n++;
      console.log('success! found new mined block:', buf_to_hex(ret.header));
      sock.notify('found', {...ret, header: buf_to_hex(ret.header)});
    });
    sock.on('close', ()=>{
      et.return();
      mine_slave_et = null;
    });
  });
  _et.on('finally', ()=>listen.close());
  return etask.wait();
}); }

export function mine_slave({pow, header, min, max, target}){
  return etask(function*()
{
  let {sock, error} = yield lifnet_connect('lifcoin/mine_slave',
    {header: buf_to_hex(header), target, min, max, pow});
  if (error)
    return {found: false, error};
  let done = ewait();
  let res;
  sock.method('update', up=>this.emit('update', up));
  sock.method('found', ret=>{
    res = {...ret, header: buf_from_hex(ret.header)};
  });
  sock.method('not_found', ret=>{
    res = {found: false, ...ret};
  });
  sock.on('close', ()=>done.return(
    res || {found: false, error: 'disconnected'}));
  this.on('finally', ()=>sock.close());
  return yield done;
}); }

export function mine_instant({netconf, saddr, target}){
  return etask(function*mine_instant(et)
{
  const _err = err=>{
    err = ''+err;
    this.emit('status', {err});
    return {err};
  };
  const _err_cheat = err=>{
    rg.cheat++;
    return _err(err);
  };
  const _status = status=>this.emit('status', {status});
  _status('searching for pool servers');
  let {rg, sock, error} = yield lifnet_connect('mine_instant',
    {rg_block: rg=>rg.mine_instant?.cheat});
  if (error)
    return _err('no mining servers online - try Solo mining ('+error+')');
  sock.on('close', ()=>this.return(_err('disconnect')));
  rg.mine_instant ||= {template: 0, mined: 0, cheat: 0, success: 0};
  _status('getting block template');
  let template = yield sock.call('mine_instant_get_template', {addr: saddr});
  if (template.error)
    return _err('pool: mine_instant_get_template '+template.error);
  if (!template.header)
    return _err('pool: no mine_instant_get_template');
  let {reward, fee} = template;
  if (!reward || !fee)
    return _err('pool: no reward/fee');
  let reward_net = reward-fee;
  if (reward_net<0)
    return _err('pool: reward less than fee');
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
  _status('mining');
  let mine_et = mine_steps(opt);
  mine_et.on('update', up=>{
    this.emit('update', {...up, mining: true, reward: reward_net});
    sock.call('mine_instant_update', {mine_h: up.mine_h});
  });
  let mine_ret = yield mine_et;
  console.log('mine_res', mine_ret);
  if (!mine_ret.found)
    return mine_ret;
  rg.mined++;
  console.log('submitting new block');
  _status('submitting winning block');
  mine_ret.header = buf_to_hex(mine_ret.header);
  let tx_ret = yield sock.call('mine_instant_submit',
    {header: mine_ret.header, addr: saddr});
  if (tx_ret.error)
    return _err_cheat('failed mine_instant_submit: '+tx_ret.error);
  let tx = tx_ret.tx;
  if (!tx)
    return _err_cheat('failed submitting winning share');
  let _tx = _try(()=>bitcoin.Transaction.fromHex(tx));
  if (!_tx)
    return _err_cheat('pool cheat: invalid tx');
  let out = tx_out_find(netconf.network, _tx, saddr);
  if (!out)
    return _err_cheat('pool cheat: didnt pay out to addr');
  let warn = {};
  reward_net = Number(out.value);
  if (reward_net<reward-fee){
    rg.cheat++;
    warn = {warn: 'pool cheat: paid only '+out.value+' - less than '
      +(reward-fee)+' promised (fee ', cheat: 1};
  }
  let txid = yield tx_broadcast(netconf, _tx);
  if (!txid)
    return _err_cheat('pool cheat: TX reward not accepted by mempool');
  rg.success++;
  console.log('success! new TX '+txid);
  _status('success');
  return {txid, tx, _tx, reward_net, reward, fee, ...warn};
}); };

let STALE_OFFER = 60; // 1 minute
// localStorage.setItem('mine_slave_enable', 'alt remote slave')
let mine_slave_enable = localStorage.getItem('mine_slave_enable')||'';
export function mine_slave_set(set){
  mine_slave_enable = set;
}
export function mine_instant_pool({wallet, reward_share, target}){
  return etask(function*mine_instant_pool()
{
  const {netconf} = wallet;
  const {pow} = netconf;
  const _this = this;
  if (mine_slave_enable.includes('slave')){
    const slave_listen = mine_slave_listen(netconf);
    slave_listen.on('update', up=>_this.emit('update', up));
    return slave_listen;
  }
  const _err = err=>{
    err = ''+err;
    this.emit('status', {err});
    return {err};
  };
  const _status = status=>this.emit('status', {status});
  _status('connecting');
  let submit_err_n = 0, submit_err = '';
  let win_n = 0, pay_n = 0, win_v = 0, pay_v = 0;
  const offers = {};
  const nslice = 1024;
  const slice_sz = Math.floor(0x100000000/nslice);
  let total_h = 0;
  try {
    const el = _el(netconf);
    const saddr = wallet.c.receiveAddress;
    _status('getting block template');
    const template = yield el.mine_get_template(saddr);
    if (template.error)
      return _err(template.error);
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
      return _err('reward smaller than fees');
    let do_update = ()=>{
      let now = Date.now();
      let hps = Math.floor((total_h-last_up.total_h)/
        Math.max(now-last_up.now, 1)*1000);
      this.emit('update', {hps, total_h, target, reward, reward_net,
        pay_target, pay_reward, pay_h, win_h, submit_err_n, submit_err,
        win_n, pay_n, win_v, pay_v});
      last_up = {now, total_h};
    };
    _status('starting mining pool');
    console.log('starting mining pool', template.header);
    do_update();
    this.on('finally', ()=>listen_mine_instant.close());
    let listen_mine_instant = lifnet_listen({topic: 'mine_instant',
      data: {reward: pay_reward, fee, target}},
      ({msg, sock})=>
    {
      console.log('client connected', msg);
      // do here the pool mining
      sock.method('mine_instant_get_template', ({addr})=>{
        if (!addr)
          return _err('no reward addr');
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
          return _err('all offer slots full');
        let now = date_time();
        let h = Buffer.from(header);
        let time_now = now-time_diff;
        header_set_time(h, time_now);
        offer = offers[i] = {min: i*slice_sz, max: (i+1)*slice_sz, addr,
          time_local: now, last_update: now, win: []};
        return {reward: pay_reward, fee, nslice,
          header: buf_to_hex(h), target: target,//pay_target,
          min: offer.min, max: offer.max};
      });
      sock.method('mine_instant_update', up=>{
        total_h += up.mine_h||0;
      });
      sock.method('mine_instant_submit', async params=>{
        let ret = await mine_instant_submit(params);
        if (ret.error){
          console.error(ret.error);
          submit_err_n++;
          submit_err = ret.error;
          _this.emit('submit_err', ret);
        } else
          console.log(ret.result);
        do_update();
        return ret;
      });
    });
    function mine_instant_submit(params){ return etask(function*(){
      let {addr, header: h, mine_h} = params;
      total_h += mine_h||0;
      if (!addr)
        return _err('no reward addr');
      let _h = buf_from_hex(h);
      let nonce = header_get_nonce(_h);
      let time = header_get_time(_h);
      // check target full block winner
      let ret = mine({pow, header: _h, min: nonce, max: nonce+1, target});
      if (ret){
        console.log('seems like got a winning block!', h);
        let ret = yield el.mine_submit_header(h);
        if (!ret?.height){
          console.error('failed submitting winning block', ret);
        } else {
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
        return _err('pool cheat: not in target');
      // locate offer, validate it matches nonce range and time range
      let i = Math.floor(nonce/slice_sz);
      let offer = offers[i];
      if (!offer)
        return _err('no offer for nonce range');
      let win = offer.win.find(w=>w.time==time && w.nonce==nonce);
      if (win)
        return {err: 'offer was already presented'};
      win = {time, nonce, time_local: date_time(), header: h};
      if (!header_match(_h, header))
        return _err('header fields do not match offer');
      let time_now = win.time_local-time_diff;
      if (time<time_base)
        return _err('header time too earlier than offer');
      if (time>time_now+1)
        return _err('header time in the future');
      console.log('valid offer - do share payout!');
      offer.win.push(win);
      nwin++;
      let tx = tx_send({wallet, saddr_to: addr, value: pay_reward-fee, fee});
      if (tx.err)
        return _err('failed payout to valid offer! serious bug!');
      pay_n++;
      pay_v += pay_reward;
      _this.emit('pay', tx);
      do_update();
      ret = yield tx_broadcast(netconf, tx.tx);
      if (!ret)
        return _err('failed broadcast TX of payout to valid offer!');
      return {result: {tx: tx.tx.toHex(), txid: tx.tx.getId(),
        reward: pay_reward-fee, fee, addr: addr}};
    }); }
    while (1){
      yield etask.sleep(1000);
      do_update();
    }
  } catch(err){ CEL(err);
    return {err: ''+err};
  }
}); }

