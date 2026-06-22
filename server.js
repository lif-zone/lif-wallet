#!/usr/bin/env node
import server from 'lif-kernel/server_lib.js';
let root = import.meta.dirname;
let map = {};
map['/lif-kernel'] = 'node_modules/lif-kernel';
map['/lif-wallet'] = '.';
server({map, root});
