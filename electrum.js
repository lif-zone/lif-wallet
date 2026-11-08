// electrum.js - ElectrumX JSON-RPC client
import {ewait, assert, str} from 'lif-kernel/util.js';
import {rpc_websocket} from 'lif-kernel/rpc.js';
import {lifnet} from 'lif-kernel/lifnet';

function ws_origin(){
  let protocol = location.protocol=='http:' ? 'ws:' :
    location.protocol=='https:' ? 'wss:' : assert();
  return protocol+'//'+location.host;
}

const g_electrum = {};
const RETRY_MS = 1000;

class electrum_rpc {
  url;
  rpc;
  error;
  state = 'offline';
  wait;
  last;
  constructor({url}){
    this.url = url;
    if (url[0]=='/')
      url = ws_origin()+url;
    this.url = url;
  }
  async connect(){
    const set_error = (error)=>{
      console.error('rpc_connect', error);
      this.error = error;
      this.close();
      this.wait.return({error});
      this.wait = null;
      return {error};
    };
    if (this.state=='online')
      return this.rpc;
    if (this.wait)
      return await this.wait;
    if (Date.now()-(this.last||0)<RETRY_MS)
      return {error: 'connect wait retry: '+this.error};
    this.wait = ewait();
    this.last = Date.now();
    try {
      let v;
      this.state = 'connect';
      if (v=str.starts(this.url, 'lif:net/')){
        let {rg, sock, error} = await lifnet.connect(
          v.rest, null, {jsonrpc: '2.0', D: 1});
        this.rpc = sock;
        if (error)
          return set_error(error);
      } else {
        this.rpc = new rpc_websocket({jsonrpc: '2.0', D: 1});
        await this.rpc.connect({url: this.url});
      }
      this.rpc.on('close', ()=>set_error('close'));
    } catch(error){
      return set_error('rpc_connect: '+error);
    }
    try {
      this.server_version = await this.rpc.T_call('server.version',
        ['lif-coin-wallet', '1.4']);
      this.server_banner = await this.rpc.T_call('server.banner');
    } catch(e){
      return set_error('server version rpc: '+e);
    }
    this.state = 'online';
    return this.wait.return(this.rpc);
  }
  async T_call(method, ...params){
    let ret = await this.connect();
    if (ret.error)
      return ret;
    return await this.rpc.T_call(method, params);
  }
  close(){
    if (this.rpc)
      this.rpc.close();
    this.rpc = null;
    this.state = 'close';
  }
  async tx_get(tx_hash, verb){
    return await this.T_call('blockchain.transaction.get', tx_hash, verb);
  }
  async tx_broadcast(txraw){
    return await this.T_call('blockchain.transaction.broadcast', txraw);
  }
  async sh_get_balance(sh){
    return await this.T_call('blockchain.scripthash.get_balance', sh);
  }
  async sh_get_history(sh){
    return await this.T_call('blockchain.scripthash.get_history', sh);
  }
  async sh_listunspent(sh){
    return await this.T_call('blockchain.scripthash.listunspent', sh);
  }
  async block_header(height){
    return await this.T_call('blockchain.block.header', height);
  }
  async block_headers(start, count){
    return await this.T_call('blockchain.block.headers', start, count);
  }
  async headers_subscribe(){
    return await this.T_call('blockchain.headers.subscribe');
  }
  async sh_subscribe(sh){
    return await this.T_call('blockchain.scripthash.subscribe', sh);
  }
  async tx_get_merkle(tx_hash, height){
    return await this.T_call('blockchain.transaction.get_merkle',
      tx_hash, height);
  }
  async estimatefee(nblocks){
    return await this.T_call('blockchain.estimatefee', nblocks);
  }
  async lif_kv_get(key){
    return await this.T_call('blockchain.lif_kv.get', key);
  }
  async mine_get_template(saddr){
    return await this.T_call('blockchain.mine.get_template', saddr);
  }
  async mine_submit_header(header){
    return await this.T_call('blockchain.mine.submit_header', header);
  }
}

export function _el(netconf){
  let url = netconf.electrum;
  let el = g_electrum[url] ||= new electrum_rpc({url});
  return el;
}
