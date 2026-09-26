import React from 'react';
import {render} from 'react-dom';
import {createRoot} from 'react-dom/client';
import './node_env.js';
let Wallet = (await import('./wallet.jsx')).default;
// head tags
import {html_elm_frag_append} from 'lif-kernel/util';
html_elm_frag_append(document.head, `
  <meta name=viewport content='width=device-width, initial-scale=1' />
  <link rel=icon href='lif-kernel/favicon.ico' />
`);
// start app
let _root = document.body.appendChild(document.createElement('div'));
let root = createRoot(_root);
root.render(<Wallet />);
