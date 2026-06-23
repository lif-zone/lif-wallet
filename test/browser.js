import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
import etask from 'lif-kernel/etask';
import {browser_open, browser_test} from 'lif-kernel/test/test_lib.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4004;
const url_base = `http://localhost:${port}`;
let proc;

describe('browser', function(){
  before(()=>etask(function*(){
    proc = spawn('node', ['server.js', '-p', ''+port], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let wait = this.wait(1000);
    proc.stdout.on('data', data=>{
      if ((''+data).includes('Serving'))
        this.return();
    });
    proc.on('error', err=>this.throw(err));
    proc.on('exit', code=>this.throw(Error('server exited early: '+code)));
    return yield wait;
  }));
  after(()=>{
    proc?.kill();
  });
  it('GET /lif-kernel/hi.js returns 200 with JS content', async()=>{
    let res = await fetch(url_base+'/lif-kernel/hi.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')||'', /javascript/);
    let body = await res.text();
    assert.ok(body.includes('hi world'), 'body should contain "hi world"');
  });
  it('load page /?/lif-wallet/', async function(){
    this.timeout(60000);
    let browser = await browser_open();
    try {
      await browser_test({browser, url: url_base+'/?/lif-wallet/',
        search: 'LIF Wallet'});
    } finally {
      await browser?.close();
    }
  });
});
