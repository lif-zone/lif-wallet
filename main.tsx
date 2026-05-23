import React from 'react';
import {render} from 'react-dom';
import {createRoot} from 'react-dom/client';
import './node_env.js';
import App from './app.jsx';
//import Wallet from './wallet.jsx';
let Wallet = (await import('./wallet.jsx')).default;
// set favicon
let link = document.createElement('link');
link.rel = 'icon';
link.href = 'lif-kernel/favicon.ico';
document.head.appendChild(link);
// add stylesheet
link = document.createElement('link');
link.rel = 'stylesheet';
link.href = import.meta.resolve('./style.css');
document.head.appendChild(link);
// start app
let _root = document.body.appendChild(document.createElement('div'));
let root = createRoot(_root);
//root.render(<App />);
root.render(<Wallet />);
