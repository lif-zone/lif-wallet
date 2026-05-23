// wallet.jsx - bright wallet - BTC, LIF, multi-wallet support
import React, {useState, useEffect, useMemo, useRef, createContext,
  useContext, useCallback,
} from 'react';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import etask from 'lif-kernel/etask.js';
import {OE, OV, OA, ewait, esleep, ipc_postmessage, CE, CEA, json, assert, str,
} from 'lif-kernel/util.js';
const {split_ws} = str;
import {settings_get, settings_save, settings_cs_fetch,
  wallet_db_init, wallet_fetch,
  wallet_add, wallet_del, wallet_update, wallets_get, wallet_get,
  hd_wallet, hd_path_def, addr_valid,
  _el, tx_send, kv_tx_send, kv_tx_edit, kv_tx_add, tx_broadcast,
  cache_clear, wallet_bal, kv_is_dns, LIF_DOMAINS,
  LIF_SERVER_DEF, lif_server_get, lif_server_set,
  mine_solo, mine_instant, mine_instant_pool,
} from './wallet_db.js';
import {mine_stats_calc} from './mine.js';

await wallet_db_init();
const settings = settings_get();
settings_cs_fetch(); // async in background

// Amount display mode
const Amount_context = createContext(null);
function Amount_provider({children}){
  const [mode, setMode] = useState(()=>settings.ls.amount||'usd');
  const set_mode = m=>{
    settings.ls.amount = m;
    settings_save();
    setMode(m);
  };
  return (
    <Amount_context.Provider value={{mode, set_mode}}>
      {children}
    </Amount_context.Provider>
  );
}

// Modal
const Modal_context = createContext(null);
function Modal_provider({children}){
  const [modal, setModal] = useState(null);
  const alert = useCallback(async(msg)=>{
    let wait = ewait();
    setModal({msg, resolve: ()=>wait.return()});
    await wait;
  }, []);
  const close = ()=>{ modal?.resolve(); setModal(null); };
  return (
    <Modal_context.Provider value={{alert}}>
      {children}
      {modal && (
        <div onClick={close}
          style={{position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background: '#fff', borderRadius: 8, padding: 24, maxWidth: 420,
              width: '90%', position: 'relative', boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
              border: '3px solid #ccc'}}>
            <button onClick={close}
              style={{position: 'absolute', top: 8, right: 10, background: 'none',
                border: 'none', fontSize: 18, cursor: 'pointer', lineHeight: 1}}>
              ✕
            </button>
            <div style={{whiteSpace: 'pre-wrap', marginTop: 4, marginRight: 16}}>{modal.msg}</div>
            <button onClick={close} style={{marginTop: 16}}>OK</button>
          </div>
        </div>
      )}
    </Modal_context.Provider>
  );
}
function useModal(){ return useContext(Modal_context); }

// Styles
const cardStyle = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: 16,
  width: 220,
  cursor: 'pointer',
  background: '#f9f9f9',
  boxSizing: 'border-box',
};

const newCardStyle = {
  ...cardStyle,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#eee',
  color: '#666',
};

// Ensure at least one LIF wallet exists
function ensure_lif_wallet(){
  const all = OV(wallets_get());
  if (all.some(w=>w.ls.network=='lif'))
    return;
  const mnemonic = bip39.generateMnemonic();
  const id = Date.now().toString();
  wallet_add({id, name: 'My first LIF wallet', network: 'lif', mnemonic,
    passphrase: '', derivPath: null});
}

// Select the best LIF wallet (highest balance)
function select_lif_wallet(){
  const lif = OV(wallets_get()).filter(w=>w.ls.network=='lif');
  let best = lif[0];
  for (const w of lif){
    if ((w.c.balance||0) > (best.c.balance||0))
      best = w;
  }
  return best.ls.id;
}

// Mining Context
const Mining_ctx = createContext(null);
function useMining(){
  const [state, setState] = useState({});
  const handles = useRef({});
  const [pool_state, setPoolState] = useState({});
  const pool_handles = useRef({});
  const pool_toggle = (wallet)=>{
    const id = wallet.ls.id;
    const h = pool_handles.current[id];
    if (h?.runningRef.current){
      h.runningRef.current = false;
      h.et?.return();
      clearInterval(h.intervalId);
      delete pool_handles.current[id];
      setPoolState(s=>({...s, [id]: {...s[id], on: false}}));
      return;
    }
    const runningRef = {current: true};
    const blockStart = Date.now();
    const intervalId = setInterval(()=>{
      setPoolState(s=>s[id]?.on
        ? {...s, [id]: {...s[id], elapsed: Math.floor((Date.now()-blockStart)/1000)}}
        : s);
    }, 1000);
    pool_handles.current[id] = {runningRef, blockStart, intervalId};
    const reward_share = 0.5;
    let cur_stats = {};
    setPoolState(s=>({...s, [id]: {on: true, stats: cur_stats, elapsed: 0, lastStatus: null}}));
    const target = target_get();
    const et = etask(function*(){
      while (runningRef.current){
        try {
          const block_et = mine_instant_pool({wallet, reward_share, target});
          block_et.on('update', up=>{
            let st = {...cur_stats, ...up, ...mine_stats_calc(up)};
            st.earn_hour = Math.floor((st.earn_hour||0)*(1-reward_share));
            cur_stats = st;
            setPoolState(s=>({...s, [id]: {...s[id], stats: {...cur_stats}}}));
          });
          block_et.on('pay', pay=>{ console.log('payout', pay); });
          block_et.on('win', win=>{
            console.log('win', win);
            if (win.height)
              cur_stats = {...cur_stats, win_n: (cur_stats.win_n||0)+1};
            setPoolState(s=>({...s, [id]: {...s[id], stats: {...cur_stats}}}));
          });
          const ret = yield block_et;
          setPoolState(s=>({...s, [id]: {...s[id], stats: {...cur_stats}, lastStatus: ret?.err||null}}));
        } catch(err){ CEA(err); }
        yield esleep(1000);
      }
      clearInterval(pool_handles.current[id]?.intervalId);
      delete pool_handles.current[id];
      setPoolState(s=>({...s, [id]: {...s[id], on: false}}));
    });
    pool_handles.current[id].et = et;
  };
  const toggle = (wallet, mode='instant')=>{
    const id = wallet.ls.id;
    const h = handles.current[id];
    if (h?.runningRef.current){
      h.runningRef.current = false;
      h.et?.return();
      clearInterval(h.intervalId);
      delete handles.current[id];
      setState(s=>({...s, [id]: {...s[id], on: false}}));
      return;
    }
    const runningRef = {current: true};
    const blockStart = Date.now();
    const intervalId = setInterval(()=>{
      setState(s=>s[id]?.on
        ? {...s, [id]: {...s[id], elapsed: Math.floor((Date.now()-blockStart)/1000)}}
        : s);
    }, 1000);
    handles.current[id] = {runningRef, blockStart, intervalId};
    let cur_stats = {win_n: 0, win_v: 0};
    setState(s=>({...s, [id]: {on: true, mode, stats: cur_stats, elapsed: 0, lastStatus: null}}));
    const {netconf} = wallet;
    const saddr = wallet.c.receiveAddress;
    const target = target_get();
    const et = etask(function*(){
      while (runningRef.current){
        try {
          let block_et;
          if (mode=='instant')
            block_et = mine_instant({netconf, saddr, target});
          else
            block_et = mine_solo({netconf, saddr, target});
          block_et.on('update', up=>{
            cur_stats = {...cur_stats, ...up, ...mine_stats_calc(up)};
            setState(s=>({...s, [id]: {...s[id], stats: {...cur_stats}}}));
          });
          const ret = yield block_et;
          if (mode=='instant'){
            if (ret.tx){ cur_stats.win_n++; cur_stats.win_v += ret.reward_net; }
          } else {
            if (ret?.height){ cur_stats.win_n++; cur_stats.win_v += ret.reward; }
          }
          setState(s=>({...s, [id]: {...s[id], stats: {...cur_stats}, lastStatus: ret.err||null}}));
        } catch(err){ CEA(err); }
        yield esleep(1000);
      }
      clearInterval(handles.current[id]?.intervalId);
      delete handles.current[id];
      setState(s=>({...s, [id]: {...s[id], on: false}}));
    });
    handles.current[id].et = et;
  };
  useEffect(()=>()=>{
    for (const h of Object.values(handles.current)){
      h.runningRef.current = false;
      h.et?.return();
      clearInterval(h.intervalId);
    }
    for (const h of Object.values(pool_handles.current)){
      h.runningRef.current = false;
      h.et?.return();
      clearInterval(h.intervalId);
    }
  }, []);
  return {state, toggle, pool_state, pool_toggle};
}

// Main App
function BrightWallet(){
  const [wallets, setWallets] = useState(()=>{ ensure_lif_wallet(); return wallets_get(); });
  const [screen, setScreen] = useState('home');
  const [activeWalletId, setActiveWalletId] = useState(null);
  const [getDomain, setGetDomain] = useState(null);
  const [selectedTxData, setSelectedTxData] = useState(null);
  const [selectedKeyData, setSelectedKeyData] = useState(null);
  const [cacheVer, setCacheVer] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [walletLoading, setWalletLoading] = useState(false);
  const [homeRefreshTick, setHomeRefreshTick] = useState(0);
  const [mineStart, setMineStart] = useState(false);
  const mining = useMining();
  useEffect(()=>{
    let raw = new URL(location.href).searchParams.get('get_domain');
    if (!raw)
      return;
    let domain = raw;
    const id = select_lif_wallet();
    setWallets(wallets_get());
    setActiveWalletId(id);
    setGetDomain(domain);
    setScreen('wallet_get_domain');
  }, []);
  const addWallet = (w_ls)=>{
    wallet_add(w_ls);
    setWallets(wallets_get());
  };
  const updateWallet = (id, changes)=>{
    OA(wallet_get(id).ls, changes);
    wallet_update(id);
    setWallets(wallets_get());
  };
  const deleteWallet = (id)=>{
    wallet_del(id);
    setWallets(wallets_get());
    setScreen('home');
    setActiveWalletId(null);
  };
  const wallet = wallet_get(activeWalletId);
  const goHome = ()=>setScreen('home');
  const goBack = ()=>{
    if (screen=='kv_send' || screen=='kv_edit')
      setScreen('kv_info');
    else if (screen=='tx_info' || screen=='kv_info')
      setScreen('wallet_info');
    else if (screen=='wallet_send' || screen=='wallet_receive' ||
      screen=='wallet_kv_add' || screen=='wallet_kv_add_raw' || screen=='wallet_settings' ||
      screen=='wallet_mine' || screen=='wallet_mine_pool' ||
      screen=='wallet_get_domain')
      setScreen('wallet_info');
    else if (screen=='devtools')
      setScreen('settings');
    else
      goHome();
  };
  return (
    <Mining_ctx.Provider value={mining}>
    <div style={{fontFamily: 'sans-serif', maxWidth: 960, margin: '0 auto', padding: 16}}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
          {screen!='home' &&
            <button onClick={goBack}>← Back</button>
          }
          <h1 style={{cursor: 'pointer', fontSize: 24, margin: 0, display: 'flex', alignItems: 'center', gap: 8}} onClick={goHome}>
            <img src={import.meta.resolve('./bright.ico')} style={{width: 32, height: 32}} />
            Bright Wallet
          </h1>
        </div>
        <div style={{display: 'flex', gap: 8}}>
          {screen=='home' && <>
            <button onClick={()=>setHomeRefreshTick(t=>t+1)} title="Refresh" style={{fontSize: 16}}>↻</button>
            <button onClick={()=>setScreen('settings')} title="Settings">⚙</button>
          </>}
          {screen=='wallet_info' && <>
            <button onClick={()=>setRefreshTick(t=>t+1)} disabled={walletLoading} title="Refresh" style={{fontSize: 16}}>
              {walletLoading ? '⏳' : '↻'}
            </button>
            <button onClick={()=>setScreen('wallet_settings')} title="Settings">⚙</button>
          </>}
        </div>
      </div>
      {screen=='home' && (
        <Home_screen
          key={`${cacheVer}-${homeRefreshTick}`}
          wallets={wallets}
          onSelect={(id)=>{ setActiveWalletId(id); setScreen('wallet_info'); }}
          onAddNew={()=>setScreen('wallet_add')}
          onMine={(id)=>{ setActiveWalletId(id); setScreen('wallet_mine'); }}
          onMinePool={(id)=>{ setActiveWalletId(id); setScreen('wallet_mine_pool'); }}
        />
      )}
      {screen=='wallet_add' && (
        <Wallet_add_screen
          wallets={wallets}
          onAdd={(w_ls)=>{ addWallet(w_ls); setActiveWalletId(w_ls.id); setScreen('wallet_info'); }}
          onCancel={goHome}
        />
      )}
      {screen=='wallet_info' && wallet && (
        <Wallet_screen
          wallet={wallet}
          onDelete={()=>deleteWallet(wallet.ls.id)}
          onUpdate={(changes)=>updateWallet(wallet.ls.id, changes)}
          onSelectTx={(data)=>{ setSelectedTxData(data); setScreen('tx_info'); }}
          onSelectKey={(data)=>{ setSelectedKeyData(data); setScreen('kv_info'); }}
          onSend={()=>setScreen('wallet_send')}
          onReceive={()=>setScreen('wallet_receive')}
          onKvAdd={()=>setScreen('wallet_kv_add')}
          onKvAddRaw={()=>setScreen('wallet_kv_add_raw')}
          onSettings={()=>setScreen('wallet_settings')}
          onMine={()=>{ setScreen('wallet_mine'); }}
          onMinePool={()=>setScreen('wallet_mine_pool')}
          refreshTick={refreshTick}
          setWalletLoading={setWalletLoading}
        />
      )}
      {screen=='wallet_send' && wallet && (
        <Send_screen
          wallet={wallet}
          onSent={()=>setScreen('wallet_info')}
        />
      )}
      {screen=='wallet_receive' && wallet && (
        <Receive_screen
          address={wallet.c.receiveAddress}
          symbol={wallet.netconf.symbol}
          netconf={wallet.netconf}
        />
      )}
      {screen=='wallet_get_domain' && wallet && (
        <Get_domain_screen
          wallet={wallet}
          domain={getDomain}
          onSent={()=>setScreen('wallet_info')}
        />
      )}
      {screen=='wallet_kv_add' && wallet && (
        <Kv_add_screen
          wallet={wallet}
          onSent={()=>setScreen('wallet_info')}
          onUpdate={(changes)=>updateWallet(wallet.ls.id, changes)}
        />
      )}
      {screen=='wallet_kv_add_raw' && wallet && (
        <Kv_add_raw_screen
          wallet={wallet}
          onSent={()=>setScreen('wallet_info')}
        />
      )}
      {screen=='wallet_settings' && wallet && (
        <Wallet_settings_subscreen
          wallet={wallet}
          onUpdate={(changes)=>updateWallet(wallet.ls.id, changes)}
          onDelete={()=>deleteWallet(wallet.ls.id)}
        />
      )}
      {screen=='wallet_mine' && wallet && (
        <Mine_screen
          wallet={wallet}
          start={mineStart}
        />
      )}
      {screen=='wallet_mine_pool' && wallet && (
        <Mine_pool_screen
          wallet={wallet}
        />
      )}
      {screen=='tx_info' && selectedTxData && wallet && (
        <Tx_info_screen
          wallet={wallet}
          tx={selectedTxData.tx}
          walletAddrs={selectedTxData.walletAddrs}
        />
      )}
      {screen=='kv_info' && selectedKeyData && wallet && (
        <Kv_info_screen
          kv_d={selectedKeyData}
          onViewTx={(tx)=>{ setSelectedTxData({tx, netconf: wallet.netconf, walletAddrs: selectedKeyData._walletAddrs}); setScreen('tx_info'); }}
          onTransfer={()=>setScreen('kv_send')}
          onEdit={(newVal)=>{ setSelectedKeyData(d=>({...d, _val_orig: d.val, val: newVal})); setScreen('kv_edit'); }}
        />
      )}
      {screen=='kv_send' && selectedKeyData && wallet && (
        <Kv_send_screen
          wallet={wallet}
          kv_d={selectedKeyData}
          onSent={()=>setScreen('wallet_info')}
        />
      )}
      {screen=='kv_edit' && selectedKeyData && wallet && (
        <Kv_edit_screen
          wallet={wallet}
          kv_d={selectedKeyData}
          onSent={()=>setScreen('wallet_info')}
        />
      )}
      {screen=='settings' && (
        <Settings_screen
          onDevtools={()=>setScreen('devtools')}
          onBack={goHome}
        />
      )}
      {screen=='devtools' && (
        <Devtools_screen
          onCacheClear={async()=>{ await cache_clear(); setCacheVer(v=>v+1); }}
          onBack={()=>setScreen('settings')}
        />
      )}
    </div>
    </Mining_ctx.Provider>
  );
}

// Home Screen
function Home_screen({wallets, onSelect, onAddNew, onMine, onMinePool}){
  return (
    <div>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 16}}>
        {OV(wallets).map(wallet=>(
          <Wallet_card
            key={wallet.ls.id}
            wallet={wallet}
            onClick={()=>onSelect(wallet.ls.id)}
            onMine={()=>onMine(wallet.ls.id)}
            onMinePool={()=>onMinePool(wallet.ls.id)}
          />
        ))}
        <div style={newCardStyle} onClick={onAddNew}>
          <div style={{textAlign: 'center'}}>
            <div style={{fontSize: 36, lineHeight: 1}}>+</div>
            <div style={{fontSize: 13, marginTop: 4}}>New Wallet</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Wallet Card (summary box on home screen)
function Wallet_card({wallet, onClick, onMine, onMinePool}){
  const {netconf} = wallet;
  const [balance, setBalance] = useState(wallet.c.balance ?? null);
  const [txCount, setTxCount] = useState(wallet.c.transactions?.length ?? null);
  const [keysOwned, setKeysOwned] = useState(wallet.c.ownedKeys?.length ?? 0);
  const [connErr, setConnErr] = useState(false);
  const derived = bip39.validateMnemonic(wallet.ls.mnemonic);

  const fetch_update = ()=>{
    if (wallet.c.balance==undefined)
      return;
    setBalance(wallet.c.balance);
    setTxCount(wallet.c.transactions.length);
    setKeysOwned(wallet.c.ownedKeys.length);
  };
  useEffect(()=>{
    if (!derived)
      return;
    (async()=>{
      try {
        await wallet_fetch(wallet);
        fetch_update();
      } catch(e){
        console.error('Wallet_card fetch error:', e);
        setConnErr(true);
      }
    })();
  }, [wallet.ls.id, wallet.ls.network, netconf.electrum]);

  if (!derived){
    return (
      <div style={{...cardStyle, color: 'red'}} onClick={onClick}>
        <p>Invalid wallet</p>
      </div>
    );
  }

  const symbol = netconf.symbol;
  const label = wallet.ls.name;
  return (
    <div style={cardStyle} onClick={onClick}>
      <div style={{fontWeight: 'bold', fontSize: 15}}>{label}</div>
      <div style={{marginTop: 10}}>
        {connErr ? (
          <span style={{color: '#c00', fontSize: 12}}>Connection error</span>
        ) : balance===null ? (
          <span style={{color: '#aaa', fontSize: 12}}>Loading…</span>
        ) : (
          <>
            <div style={{fontWeight: 'bold'}}>
              <Amount sat={balance} symbol={symbol} signed />
            </div>
            <div style={{fontSize: 12, color: '#666'}}>
              {txCount ? ''+txCount+' TXs' : 'No transactions'}
            </div>
            {keysOwned > 0 && (
              <div style={{fontSize: 12, color: '#666'}}>
                {keysOwned} {keysOwned===1?'Name':'Names'}
              </div>
            )}
          </>
        )}
      </div>
      <div style={{marginTop: 6, display: 'flex', gap: 8}} onClick={e=>e.stopPropagation()}>
        <Mine_on wallet={wallet} onMine={onMine} />
        <Mine_pool_on wallet={wallet} onMinePool={onMinePool} />
      </div>
    </div>
  );
}

// Add Wallet Screen
function Wallet_add_screen({wallets, onAdd, onCancel}){
  const [networkKey, setNetworkKey] = useState('lif');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const netconfs = settings.netconf;
  const [derivPath, setDerivPath] = useState(
    ()=>hd_path_def(netconfs['lif']));
  const [mnemonicInput, setMnemonicInput] = useState(bip39.generateMnemonic());
  const defaultName = (()=>{
    let max = 0;
    for (const w of OV(wallets)){
      const m = w.ls.name && w.ls.name.match(/^Wallet #(\d+)$/);
      if (m)
        max = Math.max(max, parseInt(m[1], 10));
    }
    return 'Wallet #'+(max+1);
  })();
  const [name, setName] = useState(defaultName);
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const handleAdd = ()=>{
    setError('');
    const cleaned = mnemonicInput.trim().toLowerCase();
    if (!bip39.validateMnemonic(cleaned))
      return void setError('Invalid mnemonic phrase');
    const mnemonic = cleaned;
    const pp = usePassphrase ? passphrase : '';
    const dp = showAdvanced ? derivPath.trim() : null;
    try {
      hd_wallet(mnemonic, networkKey, pp, dp);
    } catch(e){
      return void setError('Failed to derive wallet: '+e.message);
    }
    onAdd({id: Date.now().toString(), name: name.trim(), network: networkKey,
      mnemonic, passphrase: pp, derivPath: dp});
  };
  return (
    <div style={{maxWidth: 480}}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
        <h2 style={{margin: 0}}>Add Wallet</h2>
        {!showAdvanced &&
          <button onClick={()=>setShowAdvanced(true)}>Advanced</button>
        }
      </div>
      <div style={{marginTop: 12}}>
        <label>Name:</label>
        <input
          value={name}
          onChange={e=>setName(e.target.value)}
          placeholder="My Wallet"
          style={{display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box'}}
        />
      </div>
      <div style={{marginTop: 12}}>
        <label>Coin:</label>
        <div style={{marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4}}>
          {OE(netconfs).filter(([key])=>settings.ls.devtools||!netconfs[key].test).map(([key, netconf])=>(
            <label key={key} style={{display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer'}}>
              <input
                type="radio"
                name="network"
                value={key}
                checked={networkKey==key}
                onChange={()=>{ setNetworkKey(key); setDerivPath(hd_path_def(netconf)); }}
              />
              {netconf.symbol} ({netconf.name})
            </label>
          ))}
        </div>
      </div>
      <div style={{marginTop: 12}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <label>Wallet secret 12 words - WRITE THIS DOWN ON PAPER:</label>
        </div>
        <textarea
          rows={4}
          placeholder={'Enter the 12 or 24 secret words of your wallet'}
          value={mnemonicInput}
          onChange={e=>setMnemonicInput(e.target.value)}
          style={{display: 'block', width: '100%', marginTop: 6, boxSizing: 'border-box'}}
        />
      </div>
      <div style={{marginTop: 12}}>
        <label style={{display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer'}}>
          <input
            type="checkbox"
            checked={usePassphrase}
            onChange={e=>setUsePassphrase(e.target.checked)}
          />
          Passphrase
        </label>
        {usePassphrase && (
          <input
            type="text"
            placeholder="Passphrase"
            value={passphrase}
            onChange={e=>setPassphrase(e.target.value)}
            style={{display: 'block', width: '100%', marginTop: 6, boxSizing: 'border-box'}}
          />
        )}
      </div>
      {showAdvanced && (
        <div style={{marginTop: 12}}>
          <label>Derivation path:</label>
          <input
            value={derivPath}
            onChange={e=>setDerivPath(e.target.value)}
            style={{display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace',
              fontSize: 13, boxSizing: 'border-box'}}
          />
        </div>
      )}
      {error && <p style={{color: 'red', marginTop: 8}}>{error}</p>}
      <div style={{marginTop: 16, display: 'flex', gap: 8}}>
        <button onClick={handleAdd}>Add Wallet</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const kv_color = kstatus=>kstatus=='confirmed'?'green':kstatus=='receiving'?'#f90':'#c00';

function Kv_line({kv_key, kv_val, color, fontSize=13, mt=0}){
  return (
    <div style={{display: 'flex', gap: 8, marginTop: mt}}>
      <span style={{fontFamily: 'monospace', fontSize, flexShrink: 0, color}}>{kv_key}</span>
      <span style={{fontSize, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', flex: 1, minWidth: 0, textAlign: 'right'}}>
        {kv_val}
      </span>
    </div>
  );
}

function transactions_sorted(transactions){
  return [...transactions].sort((a,b)=>!a.timestamp ? -1 :
    !b.timestamp ? 1 :
    b.timestamp-a.timestamp
  );
}

// Wallet Detail Screen
function Wallet_screen({wallet, onDelete, onUpdate, onSelectTx,
  onSelectKey, onSend, onReceive, onKvAdd, onKvAddRaw, onSettings, onMine,
  onMinePool, refreshTick, setWalletLoading})
{
  const modal = useModal();
  const {netconf} = wallet;
  const [balance, setBalance] = useState(wallet.c.balance ?? null);
  const [transactions, setTransactions] = useState(wallet.c.transactions ?? []);
  const [ownedKeys, setOwnedKeys] = useState(wallet.c.ownedKeys ?? []);
  const [loading, setLoading] = useState(false);
  const [connErr, setConnErr] = useState(false);
  const [allAddrs, setAllAddrs] = useState(wallet.c.addrs ?? []);
  const wallet_apply = (wallet)=>{
    setBalance(wallet.c.balance);
    setTransactions(wallet.c.transactions);
    setOwnedKeys(wallet.c.ownedKeys);
    setAllAddrs(wallet.c.addrs);
  };
  useEffect(()=>{ setWalletLoading?.(loading); }, [loading]);

  useEffect(()=>{
    if (!bip39.validateMnemonic(wallet.ls.mnemonic))
      return;
    (async()=>{
      try {
        setLoading(true);
        wallet_apply(await wallet_fetch(wallet, true));
      } catch(e){
        console.error('Connect error:', e);
        setConnErr(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [wallet.ls.id, wallet.ls.network, refreshTick]);

  const symbol = netconf.symbol;
  const label = wallet.ls.name;
  return (
    <div>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <h2 style={{margin: 0}}>{label}</h2>
        <div style={{display: 'flex', gap: 8}}>
          <Mine_on wallet={wallet} onMine={onMine} />
          <Mine_pool_on wallet={wallet} onMinePool={onMinePool} />
        </div>
      </div>
      {connErr && (
        <p style={{color: '#c00', marginTop: 8}}>
          Failed to connect to Electrum server ({netconf.electrum})
        </p>
      )}
      <div style={{marginTop: 6}}>
        <strong>Balance:</strong>{' '}
        {balance===null
          ? (connErr ? 'unavailable' : 'loading…')
          : <Amount sat={balance} symbol={symbol} signed />
        }
      </div>
      <div style={{display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center'}}>
        <button onClick={onReceive}>Receive</button>
        <button onClick={onSend}>Send</button>
        {netconf.lif_kv && <button onClick={onKvAdd}>Get Domain Name</button>}
        {netconf.lif_kv && settings.ls.advanced && <button onClick={onKvAddRaw}>Get Key/Val</button>}
        {netconf.lif_kv && <button onClick={onMine}>Mine</button>}
        {netconf.lif_kv && settings.ls.advanced && balance>=50*1e8 && <button onClick={onMinePool}>Mining pool</button>}
        {settings.ls.devtools && transactions.some(tx=>!tx.timestamp) && (
          <button onClick={async()=>{
            try {
              await fetch(lif_server_get()+'/mine', {method: 'POST'});
              setLoading(true);
              wallet_apply(await wallet_fetch(wallet, true));
            } catch(e){
              await modal.alert(e.message);
            } finally {
              setLoading(false);
            }
          }}>Mine block</button>
        )}
      </div>
      <div style={{marginTop: 16}}>
        {!!ownedKeys.length && (<>
          <h3>Domain Names</h3>
          <ul style={{marginTop: 8, paddingLeft: 0, listStyle: 'none'}}>
            {ownedKeys.map((k, i)=>(
              <li key={i}
                onClick={()=>onSelectKey({...k, _tx: transactions.find(t=>t.tx_hash==k.tx), _walletAddrs: new Set(allAddrs.map(a=>a.address))})}
                style={{marginTop: 4, cursor: 'pointer', padding: '4px 0', borderBottom: '1px solid #eee'}}
              >
                <Kv_line kv_key={k.key} kv_val={json(k.val)} color={kv_color(k._kstatus)} />
              </li>
            ))}
          </ul>
        </>)}
        <h3>Transactions</h3>
        {loading ? (
          <p style={{color: '#aaa'}}>Loading…</p>
        ) : !transactions.length ? (
          <div>
            <p>No transactions yet.</p>
            <button onClick={()=>onMine()}>Mine and earn $LIF</button>
          </div>
        ) : (
          <ul style={{marginTop: 8, paddingLeft: 0, listStyle: 'none'}}>
            {transactions_sorted(transactions).map((tx, i)=>{
              const addrSet = new Set(allAddrs.map(a=>a.address));
              const kvReceived = netconf.lif_kv
                ? ownedKeys.filter(k=>k.tx==tx.tx_hash)
                : [];
              const kvSent = netconf.lif_kv
                ? (tx._vtx?.vout||[]).flatMap(v=>{
                    const saddr = v.scriptPubKey?.address||v.scriptPubKey?.addresses?.[0];
                    return (v.lif_kv && !addrSet.has(saddr)) ? v.lif_kv : [];
                  })
                : [];
              return (
                <li key={i}
                  onClick={()=>onSelectTx({tx, netconf, walletAddrs: addrSet})}
                  style={{fontSize: 13, marginTop: 4, cursor: 'pointer', padding: '4px 0',
                    borderBottom: '1px solid #eee'}}
                >
                  <div style={{display: 'flex', justifyContent: 'space-between'}}>
                    <span>
                      {tx.timestamp
                        ? new Date(tx.timestamp*1000).toLocaleString()
                        : <span style={{color: '#f90'}}>unconfirmed</span>
                      }
                    </span>
                    <Amount sat={tx.amount} symbol={symbol} signed />
                  </div>
                  {kvReceived.map((k, j)=>(
                    <Kv_line key={j} kv_key={k.key} kv_val={json(k.val)}
                      color={kv_color(k._kstatus)} fontSize={11} mt={2} />
                  ))}
                  {kvSent.map((kv, j)=>(
                    <Kv_line key={'s'+j} kv_key={kv.key} kv_val={json(kv.val)}
                      color="#c00" fontSize={11} mt={2} />
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// Wallet Delete
function Wallet_delete({onDelete, onCancel}){
  const [input, setInput] = useState('');
  const confirmed = input.trim().toLowerCase()=='yes delete';
  return (
    <div style={{marginTop: 16, border: '1px solid #c00', borderRadius: 6, padding: 12}}>
      <div style={{marginBottom: 8}}>Are you sure you want to delete this wallet?
        Write <strong>yes delete</strong> to confirm:</div>
      <input
        value={input}
        onChange={e=>setInput(e.target.value)}
        placeholder="yes delete"
        style={{display: 'block', width: '100%', boxSizing: 'border-box'}}
        autoFocus
      />
      <div style={{display: 'flex', gap: 8, marginTop: 8}}>
        <button
          onClick={onDelete}
          disabled={!confirmed}
          style={confirmed
            ? {color: '#c00', border: '1px solid #c00', background: 'transparent'}
            : {color: '#aaa', border: '1px solid #aaa', background: 'transparent', cursor: 'default'}}
        >Delete</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Wallet Settings Subscreen
function Wallet_settings_subscreen({wallet, onUpdate, onDelete}){
  const {netconf} = wallet;
  const [name, setName] = useState(wallet.ls.name);
  const [showBackup, setShowBackup] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [advanced, setAdvanced] = useState(!!settings.ls.advanced);
  const toggle_advanced = ()=>{
    settings.ls.advanced = !settings.ls.advanced;
    settings_save();
    setAdvanced(!!settings.ls.advanced);
  };
  const hasPassphrase = !!wallet.ls.passphrase;
  const derivPath = wallet.ls.derivPath || hd_path_def(netconf);
  return (
    <div style={{marginTop: 16, maxWidth: 480}}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <h3 style={{margin: 0}}>Wallet Settings</h3>
        <div style={{display: 'flex', gap: 8}}>
          <button
            onClick={()=>setShowDelete(true)}
            style={{color: '#c00', border: '1px solid #c00', background: 'transparent'}}
          >Delete Wallet</button>
          <button onClick={toggle_advanced}>
            Advanced: {advanced ? 'On' : 'Off'}
          </button>
          <button onClick={()=>setShowBackup(true)}>Backup Wallet</button>
        </div>
      </div>
      {showDelete && (
        <Wallet_delete onDelete={onDelete} onCancel={()=>setShowDelete(false)} />
      )}
      {showBackup && (
        <Wallet_backup
          wallet={wallet}
          onUpdate={onUpdate}
          onCancel={()=>setShowBackup(false)}
          force
        />
      )}
      <div style={{marginTop: 12}}>
        <label style={{color: '#666'}}>Name</label>
        <input
          value={name}
          onChange={e=>setName(e.target.value)}
          onBlur={()=>onUpdate({name: name.trim()})}
          style={{display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box'}}
        />
      </div>
      <table style={{marginTop: 12, borderCollapse: 'collapse', width: '100%'}}>
        <tbody>
          <tr>
            <td style={{padding: '5px 12px 5px 0', color: '#666', whiteSpace: 'nowrap'}}>Network</td>
            <td style={{padding: '5px 0'}}>{netconf.name}</td>
          </tr>
          <tr>
            <td style={{padding: '5px 12px 5px 0', color: '#666', whiteSpace: 'nowrap'}}>Derivation path</td>
            <td style={{padding: '5px 0', fontFamily: 'monospace', fontSize: 13}}>{derivPath}</td>
          </tr>
          <tr>
            <td style={{padding: '5px 12px 5px 0', color: '#666', whiteSpace: 'nowrap'}}>Passphrase</td>
            <td style={{padding: '5px 0'}}>{hasPassphrase ? 'Yes' : 'No'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Receive Screen
function Receive_screen({address, symbol, netconf}){
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef(null);
  const handleCopy = async()=>{
    navigator.clipboard.writeText(address);
    setCopied(true);
    await esleep(2000);
    setCopied(false);
  };
  useEffect(()=>{
    (async()=>{
      const QRCode = (await import('qrcode')).default;
      if (canvasRef.current && address)
        QRCode.toCanvas(canvasRef.current, address, {width: 220, margin: 2});
    })();
  }, [address]);
  return (
    <div style={{marginTop: 16, maxWidth: 480}}>
      <h3>Receive {symbol}</h3>
      <p style={{color: '#666', fontSize: 13, marginTop: 4}}>
        Fresh address — a new one will appear after it receives funds.
      </p>
      <div
        onClick={handleCopy}
        style={{
          fontFamily: 'monospace',
          background: '#f4f4f4',
          border: '1px solid #ccc',
          borderRadius: 4,
          padding: 12,
          marginTop: 8,
          wordBreak: 'break-all',
          fontSize: 14,
          cursor: 'pointer',
        }}
      >
        {address}
      </div>
      {copied && (
        <div style={{marginTop: 8, color: 'green', fontSize: 13}}>Copied to clipboard</div>
      )}
      {address && <canvas ref={canvasRef} style={{display: 'block', marginTop: 12}} />}
    </div>
  );
}

function mine_percent({win_h, total_h}){
  let percent = total_h/win_h; // can be >100%
  return 1 - Math.pow(0.5, percent); // limits it to be <100%
}

// Mine Fund
function Mine_fund({wallet, value, start, onEarned}){
  const {netconf} = wallet;
  const {symbol} = netconf;
  const [on, setOn] = useState(false);
  const [stats, setStats] = useState({});
  const [winV, setWinV] = useState(0);
  const [successV, setSuccessV] = useState(null);
  const runningRef = useRef(false);
  const winVRef = useRef(0);
  useEffect(()=>{
    if (start)
      mine_start();
    return ()=>{
      runningRef.current = false;
      runningRef.et?.return();
      runningRef.et = null;
    };
  }, []);
  const mine_start = ()=>{
    if (runningRef.current)
      return;
    runningRef.current = true;
    winVRef.current = 0;
    setWinV(0);
    setSuccessV(null);
    setOn(true);
    let cur_stats = {};
    runningRef.et = etask(function*(){
      const saddr = wallet.c.receiveAddress;
      const target = target_get();
      while (runningRef.current){
        try {
          const et = mine_instant({netconf, saddr, target});
          et.on('update', up=>{
            cur_stats = {...cur_stats, ...up, ...mine_stats_calc(up)};
            setStats({...cur_stats});
          });
          const ret = yield et;
          if (ret.tx){
            winVRef.current += ret.reward_net;
            setWinV(winVRef.current);
            onEarned?.(winVRef.current);
            if (wallet_bal(wallet) + winVRef.current >= value){
              runningRef.current = false;
              setSuccessV(winVRef.current);
              setOn(false);
              return;
            }
          }
        } catch(err){ CEA(err); }
        yield esleep(1000);
      }
      setOn(false);
    });
  };
  const mine_stop = ()=>{
    runningRef.current = false;
    runningRef.et?.return();
    runningRef.et = null;
    setOn(false);
  };
  const bal = wallet_bal(wallet);
  const effectiveBal = bal + winV;
  if (!successV && effectiveBal >= value)
    return null;
  const progress = successV ? 100 : (on ? mine_percent(stats) * 100 : 0);
  return (
    <div style={{marginTop: 16, border: '1px solid #aaa', borderRadius: 6, padding: 12}}>
      <div style={{background: '#ddd', borderRadius: 4, height: 10, overflow: 'hidden'}}>
        <div style={{background: '#4a4', height: '100%', width: progress+'%',
          transition: 'width 0.5s'}} />
      </div>
      {successV
        ? <div style={{fontSize: 13, color: '#4a4', marginTop: 6}}>
            Successfully mined <Amount sat={successV} symbol={symbol} signed />!
          </div>
        : on && (
          <div style={{fontSize: 12, color: '#666', marginTop: 6}}>
            Mining… {(stats.hps||0).toLocaleString()} H/s
          </div>
        )
      }
      {!successV && (
        <div style={{marginTop: 8}}>
          {!on
            ? <button onClick={mine_start}>▶ Start mining</button>
            : <button onClick={mine_stop}>⏹ Stop mining</button>
          }
        </div>
      )}
    </div>
  );
}

// Mine Screen
function target_get(){
  if (settings.ls.devtools && settings.ls.dev_target)
    return 0x1d00ffff;
}

function fmt_duration(sec){
  if (!isFinite(sec) || sec<0)
    return '—';
  sec = Math.floor(sec);
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  const mm = (''+m).padStart(2, '0');
  const ss = (''+s).padStart(2, '0');
  return h>0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function Mine_screen({wallet, start}){
  const {netconf} = wallet;
  const {symbol} = netconf;
  const {state, toggle} = useContext(Mining_ctx);
  const id = wallet.ls.id;
  const info = state[id];
  const on = !!info?.on;
  const stats = info?.stats || {};
  const elapsed = info?.elapsed || 0;
  const lastStatus = info?.lastStatus || null;
  const [mode, setMode] = useState(info?.mode || 'instant');
  useEffect(()=>{
    if (start && !on)
      toggle(wallet, mode);
  }, []);
  const mode_shares_blocks = (info?.mode||mode)=='instant' ? 'Shares' : 'Blocks';
  return (
    <div style={{marginTop: 16, maxWidth: 480}}>
      <h3>Mine for free</h3>
      <div style={{display: 'flex', gap: 16, marginTop: 10, fontSize: 14}}>
        {['instant', 'solo'].map(m=>(
          <label key={m} style={{display: 'flex', alignItems: 'center', gap: 6,
            cursor: on ? 'default' : 'pointer', opacity: on ? 0.5 : 1}}>
            <input type="radio" name="mine_mode" value={m}
              checked={(on ? info?.mode : mode)==m}
              onChange={()=>{ if (!on) setMode(m); }} disabled={on} />
            {m=='solo' ? 'Solo mining' : 'Instant mining'}
          </label>
        ))}
      </div>
      <button onClick={()=>toggle(wallet, mode)} style={{fontSize: 16, marginTop: 8}}>
        {on ? '⏹ Stop mining' : '▶ Start mining'}
      </button>
      {lastStatus && (
        <div style={{marginTop: 8, fontSize: 13, color: '#c00'}}>
          Last status: {lastStatus}
        </div>
      )}
      <table style={{marginTop: 16, borderCollapse: 'collapse', fontSize: 14}}>
        <tbody>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>
              {mode_shares_blocks}{' '}mined
            </td>
            <td><strong>
              {!stats.win_n ? '0' :
                (<>
                  {''+stats.win_n}{' '}{mode_shares_blocks},{' '}
                  <Amount sat={stats.win_v} signed symbol={symbol}/>
                </>)
              }
            </strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Speed Hash/second</td>
            <td><strong>{(stats.hps||0).toLocaleString()+' H/s'}</strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Mined hashes</td>
            <td><strong>
              {(stats.total_h||0).toLocaleString()}
              {' / '}
              {(stats.win_h||0).toLocaleString()}
            </strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Elapsed</td>
            <td><strong>
              {fmt_duration(elapsed)}
              {' / '}
              {fmt_duration(stats.win_time)}
            </strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Expected earnings</td>
            <td><strong>
              <div>
                Hour: <Amount sat={stats.earn_hour||0} signed symbol={symbol}/>
              </div>
              <div>
                Day: <Amount sat={stats.earn_hour*24||0} signed symbol={symbol}/>
              </div>
              <div>
                Month: <Amount sat={stats.earn_hour*30*24||0} signed symbol={symbol}/>
              </div>
            </strong></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Mine_pool_screen({wallet}){
  const {netconf} = wallet;
  const {symbol} = netconf;
  const {pool_state, pool_toggle} = useContext(Mining_ctx);
  const id = wallet.ls.id;
  const info = pool_state[id];
  const on = info?.on || false;
  const stats = info?.stats || {};
  const elapsed = info?.elapsed || 0;
  const lastStatus = info?.lastStatus || null;
  const toggle = ()=>pool_toggle(wallet);
  return (
    <div style={{marginTop: 16, maxWidth: 480}}>
      <h3>Mining pool server</h3>
      <button onClick={toggle} style={{fontSize: 16, marginTop: 8}}>
        {on ? '⏹ Stop mining pool' : '▶ Start mining pool'}
      </button>
      {lastStatus && (
        <div style={{marginTop: 8, fontSize: 13, color: '#c00'}}>
          Last status: {lastStatus}
        </div>
      )}
      <table style={{marginTop: 16, borderCollapse: 'collapse', fontSize: 14}}>
        <tbody>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Blocks mined</td>
            <td><strong>{!stats.win_n ? '0' : (<>
              {''+stats.win_n} Blocks,{' '}
              <Amount sat={stats.win_v} signed symbol={symbol}/>
            </>)}</strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Payouts</td>
            <td><strong>
              {!stats.pay_n ? '0' : (<>
                {''+stats.pay_n} TXs,{' '}
                <Amount sat={-stats.pay_v} signed symbol={symbol}/>
              </>)}
            </strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Errors</td>
            <td><strong>
              {!stats.submit_err_n ? '0' :
                (<span style={{color: '#c00'}}>
                  {''+stats.submit_err_n} Errors:{' '}{stats.submit_err}
                </span>)
              }
            </strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Speed Hash/second</td>
            <td><strong>{(stats.hps||0).toLocaleString()+' H/s'}</strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Mined hashes</td>
            <td><strong>
              {(stats.total_h||0).toLocaleString()}
              {' / '}
              {(stats.win_h||0).toLocaleString()}
            </strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Elapsed</td>
            <td><strong>
              {fmt_duration(elapsed)}
              {' / '}
              {fmt_duration(stats.win_time)}
            </strong></td>
          </tr>
          <tr>
            <td style={{color: '#666', paddingRight: 16}}>Expected earnings</td>
            <td><strong>
              <div>
                Hour: <Amount sat={stats.earn_hour||0} signed symbol={symbol}/>
              </div>
              <div>
                Day: <Amount sat={stats.earn_hour*24||0} signed symbol={symbol}/>
              </div>
              <div>
                Month: <Amount sat={stats.earn_hour*30*24||0} signed symbol={symbol}/>
              </div>
            </strong></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Key Detail Screen
function Kv_info_screen({kv_d, onViewTx, onTransfer, onEdit}){
  const tx = kv_d._tx;
  const date = tx?.timestamp ? new Date(tx.timestamp*1000).toLocaleString()
    : null;
  const statusColor = kv_d._kstatus=='confirmed' ? 'green' :
    kv_d._kstatus=='receiving' ? '#f90' : '#c00';
  const statusLabel = kv_d._kstatus=='confirmed' ? 'Confirmed' :
    kv_d._kstatus=='receiving' ? 'Unconfirmed' : 'Transfered';
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  const startEdit = ()=>{ setEditVal(json(kv_d.val)); setEditing(true); };
  const isSpent = kv_d._kstatus=='spent';
  return (
    <div style={{marginTop: 16, maxWidth: 600}}>
      <h3>Domain Name <span style={{color: statusColor, fontFamily: 'monospace'}}>{kv_d.key}</span></h3>
      {(()=>{ const dns = kv_is_dns(kv_d.key); return dns && (
        <div style={{marginTop: 8}}>
          {LIF_DOMAINS.map(domain=>(
            <div key={domain}>
              <a href={`https://${dns}.${domain}`} target="_blank" rel="noreferrer">
                https://{dns}.{domain}
              </a>
            </div>
          ))}
        </div>
      ); })()}
      <div style={{marginTop: 12}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
          <strong>Value:</strong>
          {!editing && !isSpent && <button onClick={startEdit} style={{fontSize: 12}}>Edit</button>}
        </div>
        {editing ? (<>
          <textarea
            rows={5}
            value={editVal}
            onChange={e=>setEditVal(e.target.value)}
            style={{display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace',
              fontSize: 13, boxSizing: 'border-box'}}
          />
          <div style={{display: 'flex', gap: 8, marginTop: 6}}>
            <button onClick={()=>{ onEdit(editVal); setEditing(false); }}>Save</button>
            <button onClick={()=>setEditing(false)}>Cancel</button>
          </div>
        </>) : (
          <div style={{fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap', marginTop: 2}}>{json(kv_d.val)}</div>
        )}
      </div>
      {tx && (<>
        <div style={{marginTop: 12}}>
          {date && <strong>Date: {date} </strong>}
          <span style={{color: statusColor, fontSize: 13}}>{statusLabel}</span>
        </div>
        <div style={{marginTop: 8, display: 'flex', gap: 8}}>
          {settings.ls.devtools && <button onClick={()=>onViewTx(tx)}>View Transaction</button>}
          <button onClick={onTransfer} disabled={isSpent}
            style={{color: '#c00', border: '1px solid #c00', background: 'transparent'}}>
            Transfer Domain Name
          </button>
        </div>
      </>)}
    </div>
  );
}

// Tx Detail Screen
function Tx_info_screen({tx, wallet, walletAddrs}){
  const date = tx.timestamp ? new Date(tx.timestamp*1000).toLocaleString()
    : null;
  const positive = tx.amount>=0;
  const {netconf} = wallet;
  const {symbol} = netconf;
  const voutAddr = (vout)=>vout.scriptPubKey?.address
    || vout.scriptPubKey?.addresses?.[0] || '?';
  return (
    <div style={{marginTop: 16, maxWidth: 600}}>
      <h3>{wallet.ls.name} transaction</h3>
      <div style={{marginTop: 8}}>
        <strong>Date:</strong> {date || <span style={{color: '#f90'}}>unconfirmed</span>}
      </div>
      {tx.height>0 &&
        <div style={{marginTop: 4}}><strong>Block:</strong> {tx.height}</div>
      }
      {tx.amount!==undefined &&
        <div style={{marginTop: 4}}>
          <strong>Amount:</strong>{' '}
          <Amount sat={tx.amount} symbol={symbol} signed />
        </div>
      }
      <div style={{marginTop: 8}}><strong>TXID: </strong>
        {netconf.explorer_tx && (
          <a href={netconf.explorer_tx+tx.tx_hash} target="_blank" rel="noreferrer">
            View on block explorer
          </a>
        )}
      </div>
      <div style={{fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 13, marginTop: 2}}>
        {tx.tx_hash}
      </div>
      {tx._vtx && (<>
        <h4 style={{marginTop: 16}}>Inputs</h4>
        {(tx._vtx.vin||[]).map((vin, i)=>{
          if (!vin.txid)
            return <div key={i} style={{fontSize: 12, color: '#888'}}>Coinbase</div>;
          const addr = vin._prevVout ? voutAddr(vin._prevVout) : '?';
          const value = vin._prevVout ? Math.round(vin._prevVout.value*1e8) : null;
          const ours = walletAddrs.has(addr);
          const color = ours ? '#c00' : 'inherit';
          return (
            <div key={i} style={{marginTop: 3}}>
              <div style={{fontFamily: 'monospace', fontSize: 12, color}}>
                {addr}{value!==null && <> <Amount sat={-value} symbol={symbol} signed /></>}{ours && ' ← yours'}
              </div>
              {(vin._prevVout?.lif_kv||[]).map((kv, j)=>(
                <Kv_line key={j} kv_key={kv.key} kv_val={json(kv.val)} color={color} fontSize={11} mt={2} />
              ))}
            </div>
          );
        })}
        <h4 style={{marginTop: 12}}>Outputs</h4>
        {(tx._vtx.vout||[]).map((vout, i)=>{
          const addr = voutAddr(vout);
          const value = Math.round(vout.value*1e8);
          const ours = walletAddrs.has(addr);
          const color = ours ? 'green' : 'inherit';
          return (
            <div key={i} style={{marginTop: 3}}>
              <div style={{fontFamily: 'monospace', fontSize: 12, color}}>
                {addr} <Amount sat={value} symbol={symbol} signed />{ours && ' ← yours'}
              </div>
              {(vout.lif_kv||[]).map((kv, j)=>(
                <Kv_line key={j} kv_key={kv.key} kv_val={json(kv.val)} color={color} fontSize={11} mt={2} />
              ))}
            </div>
          );
        })}
        {tx.fee>0 && (
          <div style={{marginTop: 8}}>
            <strong>Fee:</strong> <Amount sat={-tx.fee} symbol={symbol} signed />
          </div>
        )}
      </>)}
    </div>
  );
}

function useFormValid(){
  const [states, setStates] = useState({});
  const setValid = (key, valid)=>{
    setStates(s=>s[key]===valid ? s : {...s, [key]: valid});
  };
  const isValid = OV(states).every(Boolean);
  return {setValid, isValid};
}

// Mine On indicator
function Mine_on({wallet, onMine}){
  const {state} = useContext(Mining_ctx);
  if (!state[wallet.ls.id]?.on)
    return null;
  return (
    <span
      onClick={onMine}
      style={{cursor: 'pointer', userSelect: 'none'}}
    >🔴 Mining</span>
  );
}

// Mine Pool On indicator
function Mine_pool_on({wallet, onMinePool}){
  const {pool_state} = useContext(Mining_ctx);
  if (!pool_state[wallet.ls.id]?.on)
    return null;
  return (
    <span
      onClick={onMinePool}
      style={{cursor: 'pointer', userSelect: 'none'}}
    >🔴 Pool Mining</span>
  );
}

const AMOUNT_MODES = ['usd', 'coin'];
function Amount({sat, symbol, signed, cost}){
  const {mode, set_mode} = useContext(Amount_context);
  const sign = !signed ? null : sat>0 ? '' : sat<0 ? '-' : '';
  const color = cost ? '#c00' :
    !signed ? null : sat>0 ? 'green' : sat<0 ? '#c00' : null;
  const next_mode = e=>{
    e.stopPropagation();
    set_mode(AMOUNT_MODES[(AMOUNT_MODES.indexOf(mode)+1)%AMOUNT_MODES.length]);
  };
  const sym = symbol ? ' '+symbol : '';
  let content;
  if (mode=='usd'){
    const usd_price = OV(settings.netconf).find(nc=>nc.symbol==symbol)?.usd||0;
    const usd_val = Math.ceil(Math.abs(sat)/1e8*usd_price*100)/100;
    content = <>{sign}${usd_val.toFixed(2)}{sym}</>;
  } else {
    const [int, dec] = (Math.abs(sat)/1e8).toFixed(8).split('.');
    const sig = dec.replace(/0+$/, '');
    const zeros = dec.slice(sig.length);
    content = <>{sign}{int}{!sig.length
      ? <span style={{color: '#aaa'}}>.{zeros}</span>
      : <>.{sig}{zeros && <span style={{color: '#aaa'}}>{zeros}</span>}</>
    }{sym}</>;
  }
  return (
    <span onClick={next_mode}
      style={{fontFamily: 'monospace', cursor: 'pointer', ...(color&&{color})}}>
      {content}
    </span>
  );
}

function Balance_available({bal, symbol, cost}){
  const insufficient = cost!=null && bal<cost;
  return (
    <div style={{fontSize: 13, color: '#666', marginTop: 4}}>
      Balance: <Amount sat={bal} symbol={symbol} signed />
      {insufficient &&
        <div style={{color: 'red', fontSize: 12, marginTop: 2}}>
          Insufficient balance
        </div>
      }
    </div>
  );
}

function Balance_and_mine({wallet, bal, cost, onSufficient}){
  const symbol = wallet.netconf.symbol;
  const [earned, setEarned] = useState(0);
  const effectiveBal = bal + earned;
  const insufficient = effectiveBal < cost;
  useEffect(()=>{ onSufficient?.(!insufficient); }, [insufficient]);
  return (
    <div style={{fontSize: 13, color: '#666', marginTop: 4}}>
      Balance: <Amount sat={effectiveBal} symbol={symbol} signed />
      {insufficient &&
        <div style={{color: 'red', fontSize: 12, marginTop: 2}}>
          Insufficient balance
        </div>
      }
      <Mine_fund wallet={wallet} value={cost} onEarned={setEarned} />
    </div>
  );
}

function Fee_field({value, onChange, netconf}){
  const symbol = netconf.symbol;
  const [editing, setEditing] = useState(false);
  return (
    <div style={{marginTop: 8, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6}}>
      <span style={{color: '#666'}}>Fee:</span>
      {editing ? (
        <Amount_field value={value} onChange={onChange} symbol={symbol} min={1} autoFocus
          onBlur={()=>setEditing(false)} />
      ) : (
        <>
          <Amount sat={value} symbol={symbol} cost />
          <button onClick={()=>setEditing(true)} style={{fontSize: 11, padding: '1px 6px'}}>✎</button>
        </>
      )}
    </div>
  );
}

function Addr_field({value, onChange, netconf, onValid, placeholder='Recipient address'}){
  const modal = useModal();
  const valid = addr_valid(netconf.network, value);
  const err = value && !valid ? 'Invalid address' : '';
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  useEffect(()=>{ onValid?.(valid); }, [valid]);
  const stopScan = ()=>{
    streamRef.current?.getTracks().forEach(t=>t.stop());
    streamRef.current = null;
    setScanning(false);
  };
  const startScan = async()=>{
    if (!window.BarcodeDetector)
      return await modal.alert('QR scanning not supported in this browser');
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        {video: {facingMode: 'environment'}});
      streamRef.current = stream;
      setScanning(true);
    } catch(e){
      await modal.alert('Camera not available: '+e.message);
    }
  };
  useEffect(()=>{
    if (!scanning || !videoRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    const detector = new window.BarcodeDetector({formats: ['qr_code']});
    let rafId;
    const scan = async()=>{
      try {
        const codes = await detector.detect(videoRef.current);
        if (codes.length){
          onChange(codes[0].rawValue.trim());
          stopScan();
          return;
        }
      } catch(e){ /* ignore */ }
      rafId = requestAnimationFrame(scan);
    };
    videoRef.current.onplay = ()=>{ rafId = requestAnimationFrame(scan); };
    return ()=>{ cancelAnimationFrame(rafId); };
  }, [scanning]);
  return (
    <div>
      <div style={{display: 'flex', gap: 4, marginTop: 8}}>
        <input
          placeholder={placeholder}
          value={value}
          onChange={e=>onChange(e.target.value.trim())}
          style={{flex: 1, boxSizing: 'border-box', ...(err && {borderColor: 'red'})}}
        />
        <button onClick={startScan} title="Scan QR code"
          style={{flexShrink: 0, padding: '2px 4px', lineHeight: 0}}>
          <img src={import.meta.resolve('./qrcode.svg')} style={{width: 20, height: 20}} />
        </button>
      </div>
      {err && <div style={{color: 'red', fontSize: 12, marginTop: 2}}>{err}</div>}
      {scanning && (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
          zIndex: 1000, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16}}>
          <video ref={videoRef} autoPlay playsInline
            style={{width: 300, height: 300, objectFit: 'cover', borderRadius: 8,
              border: '2px solid white'}} />
          <button onClick={stopScan}
            style={{color: 'white', background: 'transparent',
              border: '1px solid white', padding: '6px 20px'}}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function Amount_field({value, onChange, symbol, onValid, onBlur, min=0, autoFocus}){
  const {mode, set_mode} = useContext(Amount_context);
  const usd_price = OV(settings.netconf).find(nc=>nc.symbol==symbol)?.usd||0;
  const sat_to_str = (sat, m)=>{
    sat = sat||0;
    if (m=='usd') return (sat/1e8*usd_price).toFixed(2);
    if (m=='sat') return ''+Math.round(sat);
    return (sat/1e8).toFixed(8);
  };
  const str_to_sat = (s, m)=>{
    const n = parseFloat(s)||0;
    if (m=='usd') return usd_price ? Math.round(n/usd_price*1e8) : 0;
    if (m=='sat') return Math.round(n);
    return Math.round(n*1e8);
  };
  const [str, setStr] = useState(()=>sat_to_str(value, mode));
  const strRef = useRef(str);
  strRef.current = str;
  const prev_mode = useRef(mode);
  useEffect(()=>{
    if (prev_mode.current==mode) return;
    const sat = str_to_sat(strRef.current, prev_mode.current);
    setStr(sat_to_str(sat, mode));
    prev_mode.current = mode;
  }, [mode]);
  const sat = str_to_sat(str, mode);
  const valid = sat >= min;
  useEffect(()=>{ onValid?.(valid); }, [valid]);
  const handle_change = v=>{
    setStr(v);
    onChange(str_to_sat(v, mode));
  };
  const handle_blur = ()=>{
    const s = str_to_sat(str, mode);
    setStr(sat_to_str(s, mode));
    onChange(s);
    onBlur?.();
  };
  const unit_label = mode=='usd' ? '$ '+symbol : mode=='sat' ? 'sat '+symbol : symbol;
  const placeholder = mode=='usd' ? '0.00' : mode=='sat' ? '0' : '0.00000000';
  const next_mode = e=>{
    e.stopPropagation();
    set_mode(AMOUNT_MODES[(AMOUNT_MODES.indexOf(mode)+1)%AMOUNT_MODES.length]);
  };
  return (
    <div style={{marginTop: 8}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
        <input
          type="text"
          placeholder={placeholder}
          value={str}
          onChange={e=>handle_change(e.target.value)}
          onBlur={handle_blur}
          autoFocus={autoFocus}
          style={{flex: 1, boxSizing: 'border-box',
            ...(!valid && str && {borderColor: 'red'})}}
        />
        <span onClick={next_mode}
          style={{cursor: 'pointer', fontFamily: 'monospace', fontSize: 13,
            color: '#555', whiteSpace: 'nowrap', userSelect: 'none',
            borderBottom: '1px dotted #999'}}>
          {unit_label}
        </span>
      </div>
      {!valid && str && <div style={{color: 'red', fontSize: 12, marginTop: 2}}>Invalid amount</div>}
    </div>
  );
}

// Send Screen
function Send_screen({wallet, onSent}){
  const modal = useModal();
  const {netconf, network, c: {utxos=[], changeAddrInfo}} = wallet;
  const {setValid, isValid} = useFormValid();
  const [toAddress, setToAddress] = useState('');
  const [amountSat, setAmountSat] = useState(0);
  const [sending, setSending] = useState(false);
  const [fee, setFee] = useState(0);
  const bal = wallet_bal(wallet);
  const balOk = amountSat + fee <= bal;
  useEffect(()=>{ setValid('bal', balOk); }, [balOk]);
  useEffect(()=>{
    const value = amountSat || 1;
    const saddr_to = toAddress || changeAddrInfo.address;
    setFee(tx_send({wallet, saddr_to, value}).fee||0);
  }, [amountSat, utxos]);
  const handleSend = async()=>{
    setSending(true);
    try {
      const {err, fee: _fee, tx} =
        tx_send({wallet, saddr_to: toAddress, value: amountSat, fee});
      if (err)
        throw Error(err);
      const txid = tx.getId();
      await tx_broadcast(netconf, tx);
      setFee(_fee);
      const explorerLink = netconf.explorer_tx ? `\n${netconf.explorer_tx}${txid}` : '';
      await modal.alert(`Transaction sent!\nTXID: ${txid}${explorerLink}`);
      setToAddress('');
      setAmountSat(0);
      onSent?.();
    } catch(err){
      await modal.alert(err.message);
    } finally {
      setSending(false);
    }
  };
  const symbol = netconf.symbol;
  return (
    <div style={{marginTop: 16, maxWidth: 400}}>
      <h3>Send {symbol}</h3>
      <Balance_available bal={bal} symbol={symbol} cost={amountSat+fee} />
      <Addr_field value={toAddress} onChange={setToAddress} netconf={netconf} onValid={v=>setValid('addr',v)} />
      <Amount_field value={amountSat} onChange={setAmountSat} symbol={symbol} onValid={v=>setValid('amount',v)} min={1} />
      <Fee_field value={fee} onChange={setFee} netconf={netconf} />
      <button onClick={handleSend} disabled={sending||!isValid} style={{marginTop: 8}}>
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}

function mnemonic_norm(mn){
  return split_ws(mn.toLowerCase()).join(' ');
}

// Wallet Backup Validate
function Wallet_backup({wallet, onUpdate, onCancel, force}){
  const [phase, setPhase] = useState('show');
  const [input, setInput] = useState('');
  const [done, setDone] = useState(false);
  if (done || (!force && wallet.ls.backup_date))
    return null;
  const mnemonic = wallet.ls.mnemonic;
  const hidden = mnemonic.replace(/[^\s]/g, '*');
  const words_match = mnemonic_norm(input)==mnemonic_norm(mnemonic);
  const handle_continue = ()=>{ onUpdate({backup_date: Date.now()}); setDone(true); onCancel?.(); };
  const handle_forgot = ()=>{ setPhase('show'); setInput(''); };
  return (
    <div style={{marginTop: 16, border: '1px solid #f90', borderRadius: 6, padding: 12}}>
      <div style={{fontWeight: 'bold', marginBottom: 8}}>Backup your wallet seed words:</div>
      <textarea
        rows={4}
        readOnly
        value={phase=='show' ? mnemonic : hidden}
        style={{display: 'block', width: '100%', boxSizing: 'border-box',
          fontFamily: 'monospace', fontSize: 13, background: '#fafafa'}}
      />
      {phase=='show' && (
        <div style={{display: 'flex', gap: 8, marginTop: 8}}>
          <button onClick={()=>setPhase('verify')}>I wrote it down on paper</button>
          {onCancel && <button onClick={onCancel}>Cancel</button>}
        </div>
      )}
      {phase=='verify' && (
        <>
          <div style={{display: 'flex', gap: 8, marginTop: 8}}>
            <button onClick={handle_forgot}>I forgot the seed words</button>
            {onCancel && <button onClick={onCancel}>Cancel</button>}
          </div>
          <div style={{marginTop: 12}}>
            <label>Re-enter your seed words from your backup:</label>
            <textarea
              rows={4}
              value={input}
              onChange={e=>setInput(e.target.value)}
              placeholder="Type your seed words here"
              style={{display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box',
                fontFamily: 'monospace', fontSize: 13}}
            />
          </div>
          <button style={{marginTop: 8}} disabled={!words_match} onClick={handle_continue}>
            Continue
          </button>
        </>
      )}
    </div>
  );
}

// DNS Domain registration screen (simplified: key=dns/<name>, val={site:...})
function Kv_add_screen({wallet, onSent, onUpdate}){
  const modal = useModal();
  const {netconf} = wallet;
  const {setValid, isValid} = useFormValid();
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [sending, setSending] = useState(false);
  const [nameStatus, setNameStatus] = useState(null);
  const kv_key = ()=>'dns/'+name.trim();
  const kv_val = ()=>JSON.stringify({site: site.trim()});
  const [fee, setFee] = useState(0);
  const bal = wallet_bal(wallet);
  const balOk = fee <= bal;
  useEffect(()=>{ setValid('bal', balOk); }, [balOk]);
  useEffect(()=>{
    setFee(kv_tx_add({wallet, key: kv_key(), val: kv_val()}).fee);
  }, [name, site]);
  useEffect(()=>{
    (async()=>{
      const key = kv_key();
      if (!name.trim()){
        setNameStatus(null);
        return;
      }
      setNameStatus('checking');
      await esleep(500);
      try {
        const kv = await _el(netconf).kv_get(key);
        setNameStatus(kv ? 'taken' : 'available');
      } catch(e){
        setNameStatus('error');
      }
    })();
  }, [name]);
  const handle_add = async()=>{
    if (!name.trim())
      return await modal.alert('Name is required');
    if (!site.trim())
      return await modal.alert('Site is required');
    setSending(true);
    try {
      const {fee: _fee, tx} = kv_tx_add({wallet, key: kv_key(), val: kv_val(), fee});
      await tx_broadcast(netconf, tx);
      setFee(_fee);
      await modal.alert(`Domain registration sent!\nTXID: ${tx.getId()}`);
      setName('');
      setSite('');
      onSent?.();
    } catch(err){
      await modal.alert(err.message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div style={{marginTop: 16, maxWidth: 480}}>
      <h3>Register Domain</h3>
      <div style={{marginTop: 12}}>
        <label>Domain name:</label>
        <input
          placeholder="e.g. jungo"
          value={name}
          onChange={e=>setName(e.target.value.trim())}
          style={{display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace',
            fontSize: 13, boxSizing: 'border-box'}}
        />
        {nameStatus=='checking' && <div style={{fontSize: 12, color: '#aaa', marginTop: 3}}>Checking…</div>}
        {nameStatus=='available' && <div style={{fontSize: 12, color: 'green', marginTop: 3}}>Available</div>}
        {nameStatus=='taken' && <div style={{fontSize: 12, color: '#c00', marginTop: 3}}>Already taken</div>}
      </div>
      <div style={{marginTop: 12}}>
        <label>Site:</label>
        <input
          placeholder="e.g. lif:git/myproject"
          value={site}
          onChange={e=>setSite(e.target.value.trim())}
          style={{display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace',
            fontSize: 13, boxSizing: 'border-box'}}
        />
      </div>
      <Fee_field value={fee} onChange={setFee} netconf={netconf} />
      <Balance_and_mine bal={bal} wallet={wallet} cost={fee} onSufficient={ok=>setValid('bal', ok)} />
      <Wallet_backup wallet={wallet} onUpdate={onUpdate} />
      <button onClick={handle_add} disabled={sending||!isValid||nameStatus=='taken'} style={{marginTop: 12}}>
        {sending ? 'Registering…' : 'Register'}
      </button>
    </div>
  );
}

// Raw KV add screen (devtools)
function Kv_add_raw_screen({wallet, onSent}){
  const modal = useModal();
  const {netconf} = wallet;
  const {setValid, isValid} = useFormValid();
  const [kv_key, set_kv_key] = useState('');
  const [kv_val, set_kv_val] = useState('');
  const [sending, setSending] = useState(false);
  const [nameStatus, setNameStatus] = useState(null);
  const [valError, setValError] = useState(false);
  const [fee, setFee] = useState(0);
  const bal = wallet_bal(wallet);
  const balOk = fee <= bal;
  useEffect(()=>{ setValid('bal', balOk); }, [balOk]);
  useEffect(()=>{
    setFee(kv_tx_add({wallet, key: kv_key.trim(), val: kv_val.trim()}).fee);
  }, [kv_key, kv_val]);
  useEffect(()=>{
    (async()=>{
      const key = kv_key.trim();
      if (!key){
        setNameStatus(null);
        return;
      }
      setNameStatus('checking');
      await esleep(500);
      try {
        const kv = await _el(netconf).kv_get(key);
        setNameStatus(kv ? 'taken' : 'available');
      } catch(e){
        setNameStatus('error');
      }
    })();
  }, [kv_key]);
  const handle_add = async()=>{
    if (!kv_key.trim())
      return await modal.alert('Key is required');
    if (!kv_val.trim())
      return await modal.alert('Value is required');
    setSending(true);
    try {
      const {fee: _fee, tx, err} = kv_tx_add({wallet, key: kv_key.trim(), val: kv_val.trim(), fee});
      if (err)
        await modal.alert(err);
      await tx_broadcast(netconf, tx);
      setFee(_fee);
      await modal.alert(`Key/value sent!\nTXID: ${tx.getId()}`);
      set_kv_key('');
      set_kv_val('');
      onSent?.();
    } catch(err){
      await modal.alert(err.message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div style={{marginTop: 16, maxWidth: 480}}>
      <h3>Write Key/Value</h3>
      <div style={{marginTop: 12}}>
        <label>Key:</label>
        <input
          placeholder="e.g. dns/jungo"
          value={kv_key}
          onChange={e=>set_kv_key(e.target.value.trim())}
          style={{display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace',
            fontSize: 13, boxSizing: 'border-box'}}
        />
        {nameStatus=='checking' && <div style={{fontSize: 12, color: '#aaa', marginTop: 3}}>Checking…</div>}
        {nameStatus=='available' && <div style={{fontSize: 12, color: 'green', marginTop: 3}}>Available</div>}
        {nameStatus=='taken' && <div style={{fontSize: 12, color: '#c00', marginTop: 3}}>Already taken</div>}
      </div>
      <div style={{marginTop: 12}}>
        <label>Value:</label>
        <textarea
          rows={5}
          placeholder={'{"site": "lif:git/..."}'}
          value={kv_val}
          onChange={e=>{
            set_kv_val(e.target.value);
            try {
              JSON.parse(e.target.value);
              setValError(false);
            } catch { setValError(true); }
          }}
          style={{display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace',
            fontSize: 13, boxSizing: 'border-box'}}
        />
        {valError && <div style={{fontSize: 12, color: '#c00', marginTop: 3}}>Invalid JSON</div>}
      </div>
      <Fee_field value={fee} onChange={setFee} netconf={netconf} />
      <Balance_and_mine bal={bal} wallet={wallet} cost={fee} onSufficient={ok=>setValid('bal', ok)} />
      <button onClick={handle_add} disabled={sending||!isValid||nameStatus=='taken'||valError} style={{marginTop: 12}}>
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}

// KV Name Transfer Screen
function Kv_send_screen({wallet, kv_d, onSent}){
  const modal = useModal();
  const {netconf, network} = wallet;
  const {setValid, isValid} = useFormValid();
  const [toAddress, setToAddress] = useState('');
  const [sending, setSending] = useState(false);
  const [fee, setFee] = useState(()=>{
    const saddr_to = wallet.c.changeAddrInfo.address;
    return kv_tx_send({wallet, kv_d, saddr_to}).fee;
  });
  const bal = wallet_bal(wallet);
  const balOk = fee <= bal;
  useEffect(()=>{ setValid('bal', balOk); }, [balOk]);

  const handleTransfer = async()=>{
    setSending(true);
    try {
      const {fee: _fee, tx, err} = kv_tx_send({wallet, kv_d, saddr_to: toAddress.trim(), fee});
      if (err)
        return await modal.alert(err);
      const txid = tx.getId();
      await tx_broadcast(netconf, tx);
      setFee(_fee);
      if (settings.ls.devtools)
        await modal.alert(<>Name transferred!<br/>TXID: {txid}{netconf.explorer_tx && <><br/><a href={netconf.explorer_tx+txid} target="_blank" rel="noopener noreferrer">View in block explorer</a></>}</>);
      else
        await modal.alert('Name transferred!');
      onSent?.();
    } catch(err){
      await modal.alert(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{marginTop: 16, maxWidth: 400}}>
      <h3>Transfer Name</h3>
      <Balance_and_mine bal={bal} wallet={wallet} cost={fee} onSufficient={ok=>setValid('bal', ok)} />
      <div style={{marginTop: 8, color: '#666', fontSize: 13}}>
        Transferring: <span style={{fontFamily: 'monospace'}}>{kv_d.key}</span>
      </div>
      <Addr_field value={toAddress} onChange={setToAddress} netconf={netconf} onValid={v=>setValid('addr',v)} />
      <Fee_field value={fee} onChange={setFee} netconf={netconf} />
      <button onClick={handleTransfer} disabled={sending||!isValid} style={{marginTop: 8}}>
        {sending ? 'Transferring…' : 'Transfer'}
      </button>
    </div>
  );
}

// KV Name Edit Screen
function Kv_edit_screen({wallet, kv_d, onSent}){
  const modal = useModal();
  const {netconf} = wallet;
  const {setValid, isValid} = useFormValid();
  const [sending, setSending] = useState(false);
  const [fee, setFee] = useState(()=>{
    return kv_tx_edit({wallet, kv_d}).fee;
  });
  const bal = wallet_bal(wallet);
  const balOk = fee <= bal;
  useEffect(()=>{ setValid('bal', balOk); }, [balOk]);

  const handleSave = async()=>{
    setSending(true);
    try {
      const {fee: _fee, tx, err} = kv_tx_edit({wallet, kv_d, fee});
      if (err)
        return await modal.alert(err);
      const txid = tx.getId();
      await tx_broadcast(netconf, tx);
      setFee(_fee);
      const explorerLink = netconf.explorer_tx ? `\n${netconf.explorer_tx}${txid}` : '';
      await modal.alert(`Name updated!\nTXID: ${txid}${explorerLink}`);
      onSent?.();
    } catch(err){
      await modal.alert(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{marginTop: 16, maxWidth: 400}}>
      <h3>Edit Domain Name</h3>
      <Balance_and_mine bal={bal} wallet={wallet} cost={fee} onSufficient={ok=>setValid('bal', ok)} />
      <div style={{marginTop: 8, color: '#666', fontSize: 13}}>
        Name: <span style={{fontFamily: 'monospace'}}>{kv_d.key}</span>
      </div>
      <div style={{marginTop: 8, color: '#666', fontSize: 13}}>
        New value: <span style={{fontFamily: 'monospace'}}>{kv_d.val}</span>
      </div>
      <Fee_field value={fee} onChange={setFee} netconf={netconf} />
      <button onClick={handleSave} disabled={sending||!isValid} style={{marginTop: 12}}>
        {sending ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function sub_dns(hostname){
  let v;
  let h = hostname.split('.').reverse();
  let sub_idx;
  if (h[0]=='localhost')
    sub_idx = 1; // LIF-DOMAIN.localhost
  else
    sub_idx = 2; // LIF-DOMAIN.lif.zone
  return h.slice(sub_idx).reverse().join('.');
}

function Get_domain_screen({wallet, onSent, domain=''}){
  const modal = useModal();
  const {netconf} = wallet;
  const {setValid, isValid} = useFormValid();
  const [name, setName] = useState(sub_dns(domain));
  const [site, setSite] = useState('');
  const [sending, setSending] = useState(false);
  const [nameStatus, setNameStatus] = useState(null);
  const kv_key = ()=>'dns/'+name.trim();
  const kv_val = ()=>JSON.stringify({site: site.trim()});
  const [fee, setFee] = useState(0);
  const bal = wallet_bal(wallet);
  const balOk = fee <= bal;
  useEffect(()=>{ setValid('bal', balOk); }, [balOk]);
  useEffect(()=>{
    let {fee} = kv_tx_add({wallet, key: kv_key(), val: kv_val()});
    setFee(fee);
  }, [name, site]);
  useEffect(()=>{
    (async()=>{
      const key = kv_key();
      if (!name.trim()){
        setNameStatus(null);
        return;
      }
      setNameStatus('checking');
      await esleep(500);
      try {
        const kv = await _el(netconf).kv_get(key);
        setNameStatus(kv ? 'taken' : 'available');
      } catch(e){
        setNameStatus('error');
      }
    })();
  }, [name]);
  const handle_add = async()=>{
    if (!name.trim())
      return await modal.alert('Name is required');
    if (!site.trim())
      return await modal.alert('Site is required');
    setSending(true);
    try {
      const {fee: _fee, tx} = kv_tx_add({wallet, key: kv_key(), val: kv_val(), fee});
      await tx_broadcast(netconf, tx);
      setFee(_fee);
      await modal.alert(`Domain registration sent!\nTXID: ${tx.getId()}`);
      setName('');
      setSite('');
      onSent?.();
    } catch(err){
      await modal.alert(err.message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div style={{marginTop: 16, maxWidth: 480}}>
      <h3>Get Domain</h3>
      <div>Cost: <Amount value={fee} netconf={netconf} cost /></div>
      <Balance_and_mine bal={bal} wallet={wallet} cost={fee} onSufficient={ok=>setValid('bal', ok)} />
      <div style={{marginTop: 12}}>
        <label>Domain name:</label>
        <input
          placeholder="e.g. jungo"
          value={name}
          onChange={e=>setName(e.target.value.trim())}
          style={{display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace',
            fontSize: 13, boxSizing: 'border-box'}}
        />
        {nameStatus=='checking' && <div style={{fontSize: 12, color: '#aaa', marginTop: 3}}>Checking…</div>}
        {nameStatus=='available' && <div style={{fontSize: 12, color: 'green', marginTop: 3}}>Available</div>}
        {nameStatus=='taken' && <div style={{fontSize: 12, color: '#c00', marginTop: 3}}>Already taken</div>}
      </div>
      <div style={{marginTop: 12}}>
        <label>Site:</label>
        <input
          placeholder="e.g. lif:git/myproject"
          value={site}
          onChange={e=>setSite(e.target.value.trim())}
          style={{display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace',
            fontSize: 13, boxSizing: 'border-box'}}
        />
      </div>
      <button onClick={handle_add} disabled={sending||!isValid||nameStatus=='taken'} style={{marginTop: 12}}>
        {sending ? 'Registering…' : 'Register'}
      </button>
    </div>
  );
}

// Settings Screen
function Settings_screen({onDevtools, onBack})
{
  const modal = useModal();
  const {ls, netconf: netconfs} = settings;
  const [electrum, set_electrum] = useState(()=>{
    const s = {};
    for (const key in netconfs)
      s[key] = settings.netconf[key].electrum;
    return s;
  });
  const handleSave = async()=>{
    for (const key in netconfs){
      const v = electrum[key].trim();
      ls.netconf[key].electrum = v || settings.netconf_def[key].electrum;
    }
    settings_save();
    await modal.alert('Settings saved');
  };
  const handleReset = (key)=>{
    set_electrum(v=>({...v, [key]: settings.netconf_def[key].electrum}));
  };
  const [devtools, set_devtools] = useState(()=>!!settings.ls.devtools);
  const onDevToolsToggle = v=>{
    set_devtools(v);
    settings.ls.devtools = !!v;
    settings_save();
  };
  return (
    <div style={{maxWidth: 520}}>
      <h2>Settings</h2>
      <h3 style={{marginTop: 16}}>ElectrumX Servers</h3>
      <p style={{fontSize: 13, color: '#666', marginTop: 4}}>
        Configure the ElectrumX server URL for each network.
      </p>
      {OE(netconfs).filter(([key])=>devtools||!netconfs[key]?.test).map(([key, nc])=>(
        <div key={key} style={{marginTop: 14}}>
          <label style={{fontWeight: 'bold'}}>{nc.name}:</label>
          <div style={{display: 'flex', gap: 6, marginTop: 4}}>
            <input
              value={electrum[key]}
              onChange={e=>set_electrum(v=>({...v, [key]: e.target.value}))}
              style={{flex: 1, fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box'}}
            />
            <button onClick={()=>handleReset(key)} title="Reset to default">↺</button>
          </div>
        </div>
      ))}
      <button onClick={handleSave} style={{marginTop: 20}}>Save Settings</button>
      <div style={{marginTop: 28}}>
        <label style={{display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer'}}>
          <input
            type="checkbox"
            checked={devtools}
            onChange={e=>onDevToolsToggle(e.target.checked)}
          />
          Enable Developer Tools
        </label>
        {devtools && (
          <button onClick={onDevtools} style={{marginTop: 10}}>Developer Tools</button>
        )}
      </div>
    </div>
  );
}

// Developer Tools Screen
function Devtools_screen({onCacheClear, onBack}){
  const [lifServer, setLifServer] = useState(lif_server_get);
  const [lifnode_cmd, set_lifnode_cmd] = useState(null);
  const [lifnode_res, set_lifnode_res] = useState(null);
  const [dev_target, set_dev_target] = useState(()=>!!settings.ls.dev_target);
  const on_dev_target_toggle = v=>{
    settings.ls.dev_target = !!v;
    set_dev_target(v);
    settings_save();
  };
  const handleServerChange = (val)=>{
    setLifServer(val);
    lif_server_set(val);
  };
  const handle_lifnode_post = async(uri)=>{
    const url = `${lifServer}${uri}`;
    set_lifnode_cmd(`curl -X POST ${url}`);
    set_lifnode_res(null);
    try {
      const res = await fetch(url, {method: 'POST'});
      set_lifnode_res(await res.json());
    } catch(e){
      set_lifnode_res({error: e.message});
    }
  };
  const handle_reset_mempool = async()=>handle_lifnode_post('/reset_mempool');
  const handle_mine_block = async()=>handle_lifnode_post('/mine');
  return (
    <div style={{maxWidth: 520}}>
      <h2>Developer Tools</h2>
      <div style={{marginTop: 16}}>
        <button onClick={onCacheClear}>Clear Cache</button>
        <p style={{fontSize: 13, color: '#666', marginTop: 6}}>
          Clears all cached wallet data and re-fetches from Electrum.
        </p>
      </div>
      <div style={{marginTop: 28}}>
        <label style={{display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer'}}>
          <input
            type="checkbox"
            checked={dev_target}
            onChange={e=>on_dev_target_toggle(e.target.checked)}
          />
          Test real world target (10min hashing at 6.6M H/s)
        </label>
      </div>
      <div style={{marginTop: 20}}>
        <label style={{fontWeight: 'bold'}}>Lifcoin Server:</label>
        <div style={{display: 'flex', gap: 6, marginTop: 4}}>
          <input
            value={lifServer}
            onChange={e=>handleServerChange(e.target.value)}
            placeholder={LIF_SERVER_DEF}
            style={{flex: 1, fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box'}}
          />
          <button onClick={()=>handleServerChange(LIF_SERVER_DEF)} title="Reset to default">↺</button>
        </div>
      </div>
      <div style={{marginTop: 16, display: 'flex', gap: 8}}>
        <button onClick={handle_reset_mempool}>Reset lifcoin mempool</button>
        <button onClick={handle_mine_block}>Mine lifcoin block</button>
      </div>
      {lifnode_cmd && (
        <pre style={{marginTop: 8, fontSize: 12, background: '#f4f4f4',
          padding: 8, borderRadius: 4, overflowX: 'auto'}}>
          {lifnode_cmd}{'\n'}
          {lifnode_res ? JSON.stringify(lifnode_res, null, 2) : 'Fetching...'}
        </pre>
      )}
    </div>
  );
}

function App(){
  return <Amount_provider><Modal_provider><BrightWallet /></Modal_provider></Amount_provider>;
}
export default App;
