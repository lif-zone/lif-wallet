// LICENSE_CODE JPL: mine_worker.js
import {ipc_postmessage} from 'lif-kernel/util.js';
import {mine} from './mine.js';
let version = '26.4.23';
let ipc;
function init(){
  ipc = new ipc_postmessage();
  globalThis.addEventListener("message", event=>{
    if (ipc.accept(event))
      return;
    console.error('invalid message', event.data, event);
  });
  ipc.method('version', ()=>({version}));
  ipc.method('mine', arg=>{
    console.log('mining', arg);
    arg.header = Buffer.from(arg.header, 'hex');
    let tstart = Date.now();
    let ret = mine(arg) || {};
    ret.tstart = tstart;
    ret.tend = Date.now();
    if (ret.header)
      ret.header = ret.header.toString('hex');
    console.log('mining res', ret);
    return ret;
  });
}
init();
