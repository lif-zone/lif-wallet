import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
import etask from 'lif-kernel/etask';
import {browser_open, browser_test, server_open, fetch_test,
} from 'lif-kernel/test/test_lib.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4004;
const url_base = `http://localhost:${port}`;
const cmd = ['server.js', '-p', ''+port];

describe('browser', function(){
  let proc, browser;
  before(async()=>{
    proc = await server_open({cmd, search: 'Serving'});
    browser = await browser_open();
  });
  after(()=>{
    browser?.close();
    proc?.kill();
  });
  it('GET /lif-kernel/hi.js', async()=>{
    await fetch_test({url: url_base+'/lif-kernel/hi.js', search: 'hi world'});
  });
  it('page /?/lif-wallet/', async function(){
    this.timeout(60000);
    let browser = await browser_open();
    await browser_test({browser, url: url_base+'/?/lif-wallet/',
      search: 'LIF Wallet'});
  });
});
