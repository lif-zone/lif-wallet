// node env in browser
globalThis.global = globalThis; // for bsock npm
import buffer from 'buffer';
globalThis.Buffer = buffer.Buffer;
// process npm
// https://github.com/defunctzombie/node-process/blob/master/browser.js
process.env.NODE_BACKEND = 'js'; // for bcrypto npm
process.on = ()=>{}; // TODO need require('events')
process.argv = [''+globalThis.location];
process.exit = code=>console.warn('process.exit('+(code||0)+')');
let nextId = 1;
let callbacks = {};
globalThis.setImmediate = function(fn /*, ...args */){
  if (typeof fn!='function')
    throw new TypeError('setImmediate argument must be a function');
  var id = nextId++;
  var args = Array.prototype.slice.call(arguments, 1);
  callbacks[id] = true; // mark as active
  setTimeout(function(){
    if (!callbacks[id])
      return;
    delete callbacks[id];
    fn.apply(null, args);
  }, 0);
  return id;
};
globalThis.clearImmediate = function(id){
  if (id)
    delete callbacks[id];
};

