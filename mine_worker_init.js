import './node_env.js';
// Chrome 148 Workers in Chrome 148 still have a bug of incorrect loading
// order of sub-module static import, which gets modules that need Buffer
// to be loaded before Buffer is added to global scope. To meantime solve it
// dynamic import() is used.
// see also lif-kernel/kernel.js
//import './mine_worker.js';
await import('./mine_worker.js');

