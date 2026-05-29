// node env in browser
import compat, {setImmediate, clearImmediate} from 'lif-kernel/compat';
globalThis.global = globalThis; // for bsock npm
import buffer from 'buffer';
globalThis.Buffer = buffer.Buffer;
// process npm
// https://github.com/defunctzombie/node-process/blob/master/browser.js
process.env.NODE_BACKEND = 'js'; // for bcrypto npm
process.on = ()=>{}; // TODO need require('events')
process.argv = [''+globalThis.location];
process.exit = code=>console.warn('process.exit('+(code||0)+')');
globalThis.setImmediate = setImmediate; 
globalThis.clearImmediate = clearImmediate;

