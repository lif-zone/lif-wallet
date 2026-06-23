import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
import etask from 'lif-kernel/etask';

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

  it('browser: http://localhost loads successfully', async function(){
    this.timeout(60000);
    let browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      let page = await browser.newPage();
      let errors = [];
      let last_activity = Date.now();
      const bump = ()=>{ last_activity = Date.now(); };
      page.on('pageerror', err=>errors.push(err.message));
      page.on('console', bump);
      page.on('response', bump); // network responses also count as progress
      let res = await page.goto(url_base+'?/lif-wallet/',
        {waitUntil: 'domcontentloaded'});
      assert.equal(res.status(), 200);
      // The kernel installs a ServiceWorker then reloads — wait for that navigation
      await page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 15000})
        .catch(()=>{}); // optional: may not happen if SW already installed
      // Poll until React renders "LIF Wallet"; fail if no console log for 5s (hang detection)
      await (async()=>{
        while (true){
          await new Promise(r=>setTimeout(r, 500));
          if (Date.now()-last_activity>10000)
            throw new Error('hang: no console/network activity for 5s');
          let found = await page.evaluate(()=>
            [...document.querySelectorAll('div')].some(
              el=>el.textContent.includes('LIF Wallet'))
          );
          if (found)
            return;
        }
      })();
      assert.equal(errors.length, 0, 'page JS errors: '+errors.join(', '));
    } finally {
      await browser.close();
    }
  });
});
