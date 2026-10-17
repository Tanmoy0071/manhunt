'use client';
import { useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import 'leaflet/dist/leaflet.css';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const MAX_AGE = 10000, TAG_M = 10, OUT_SEC = 20, WALK_MS = 2;
const uid = () => Math.random().toString(36).slice(2, 8);
const dist = (a, b) => {
  const r = Math.PI / 180, R = 6371000;
  const dA = (b.lat - a.lat) * r, dO = (b.lng - a.lng) * r;
  const h = Math.sin(dA / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const mmss = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function Page() {
  const [screen, setScreen] = useState('home');
  const [name, setName] = useState('');
  const [codeIn, setCodeIn] = useState('');
  const [code, setCode] = useState('');
  const [isHost, setHost] = useState(false);
  const [players, setPlayers] = useState({});
  const [roles, setRoles] = useState({});
  const [cfg, setCfg] = useState({ radius: 300, duration: 30, pingSec: 60, delaySec: 15, convert: true });
  const [startAt, setStartAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [myPos, setMyPos] = useState(null);
  const [tagReq, setTagReq] = useState(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const id = useRef(uid()).current;
  const ch = useRef(null), hist = useRef({}), pos = useRef(null), outSince = useRef(null);
  const map = useRef(null), layer = useRef(null), Lf = useRef(null);

  const send = (event, payload) => ch.current?.send({ type: 'broadcast', event, payload });
  const latest = k => hist.current[k]?.at(-1);
  const at = (k, t) => { const h = hist.current[k] || []; for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i]; return null; };

  async function join(c, host) {
    if (!name.trim()) return setErr('Enter a nickname first.');
    setErr(''); setCode(c); setHost(host); setScreen('lobby');
    const channel = sb.channel('manhunt:' + c, { config: { broadcast: { self: true }, presence: { key: id } } });
    channel
      .on('presence', { event: 'sync' }, () => {
        const s = channel.presenceState();
        setPlayers(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v[0]])));
      })
      .on('broadcast', { event: 'pos' }, ({ payload: p }) => {
        const h = (hist.current[p.id] ||= []);
        h.push({ ...p, t: Date.now() });
        if (h.length > 400) h.shift();
      })
      .on('broadcast', { event: 'start' }, ({ payload }) => {
        setCfg(payload.cfg); setRoles(payload.roles); setStartAt(Date.now() + 3000); setScreen('game');
      })
      .on('broadcast', { event: 'tagreq' }, ({ payload }) => { if (payload.runnerId === id) setTagReq(payload); })
      .on('broadcast', { event: 'tagres' }, ({ payload }) => {
        if (payload.hunterId !== id) return;
        setNotice(payload.ok ? 'Tag confirmed!' : 'Runner declined the tag.'); setTimeout(() => setNotice(''), 4000);
      })
      .on('broadcast', { event: 'out' }, ({ payload }) => setRoles(r => ({ ...r, [payload.id]: payload.to })))
      .subscribe(s => { if (s === 'SUBSCRIBED') channel.track({ name: name.trim(), host }); });
    ch.current = channel;
  }

  // GPS
  useEffect(() => {
    if (screen === 'home') return;
    if (!navigator.geolocation) return setErr('This browser has no GPS.');
    const w = navigator.geolocation.watchPosition(
      p => { const v = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; pos.current = v; setMyPos(v); },
      e => setErr('Location error: ' + e.message), { enableHighAccuracy: true, maximumAge: 1000 });
    return () => navigator.geolocation.clearWatch(w);
  }, [screen === 'home']);

  // 1s tick
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);

  // share location only during the game
  useEffect(() => {
    if (screen !== 'game' || roles[id] === 'out') return;
    const s = () => pos.current && send('pos', { id, ...pos.current });
    s(); const i = setInterval(s, 2000); return () => clearInterval(i);
  }, [screen, roles[id]]);

  // keep screen awake
  useEffect(() => {
    if (screen !== 'game') return;
    let lock; navigator.wakeLock?.request('screen').then(l => (lock = l)).catch(() => {});
    return () => lock?.release();
  }, [screen]);

  // map init
  useEffect(() => {
    if (screen !== 'game') return;
    let m, dead = false;
    (async () => {
      const L = (await import('leaflet')).default; if (dead) return;
      Lf.current = L;
      m = L.map('map', { zoomControl: false }).setView([cfg.center.lat, cfg.center.lng], 17);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
      layer.current = L.layerGroup().addTo(m); map.current = m;
    })();
    return () => { dead = true; m?.remove(); map.current = null; };
  }, [screen]);

  // derived state
  const myRole = roles[id];
  const alive = Object.keys(roles).filter(k => roles[k] !== 'out');
  const runnersLeft = alive.filter(k => roles[k] === 'runner').length;
  const endAt = startAt + cfg.duration * 60000;
  const over = screen === 'game' && now > startAt && (now >= endAt || runnersLeft === 0);
  const playing = screen === 'game' && now >= startAt && !over;
  const interval = cfg.pingSec * 1000;
  const lastPing = startAt + Math.floor((now - startAt) / interval) * interval;
  const outside = myPos && cfg.center && dist(myPos, cfg.center) > cfg.radius;

  const marks = [];
  if (playing) for (const k of alive) {
    if (k === id) continue;
    const r = roles[k]; let s, kind = 'live';
    if (myRole === 'runner') s = r === 'hunter' ? at(k, now - cfg.delaySec * 1000) : latest(k);
    else if (r === 'runner') { s = at(k, lastPing); kind = 'ping'; }
    else s = latest(k);
    if (s) marks.push({ k, r, s, kind });
  }
  const fresh = k => { const s = latest(k); return s && now - s.t < MAX_AGE ? s : null; };
  const nearest = playing && myRole === 'hunter' && myPos
    ? alive.filter(k => roles[k] === 'runner' && fresh(k)).map(k => ({ k, d: dist(myPos, fresh(k)) })).sort((a, b) => a.d - b.d)[0] : null;
  const target = nearest && nearest.d <= TAG_M ? nearest.k : null;

  // boundary rule
  useEffect(() => {
    if (!playing || myRole === 'out') return;
    if (outside) { outSince.current ||= Date.now(); if (Date.now() - outSince.current > OUT_SEC * 1000) send('out', { id, to: 'out' }); }
    else outSince.current = null;
  }, [now]);

  // draw
  useEffect(() => {
    const L = Lf.current, lg = layer.current;
    if (!L || !lg || !cfg.center) return;
    lg.clearLayers();
    L.circle([cfg.center.lat, cfg.center.lng], { radius: cfg.radius, color: '#f5b53d', fill: false, dashArray: '8' }).addTo(lg);
    if (myPos) L.circleMarker([myPos.lat, myPos.lng], { radius: 9, color: '#fff', fillColor: '#4da3ff', fillOpacity: 1 }).addTo(lg);
    marks.forEach(m => {
      const c = m.r === 'hunter' ? '#ff5a3c' : '#7bdc6a';
      L.circleMarker([m.s.lat, m.s.lng], { radius: 8, color: '#fff', fillColor: c, fillOpacity: m.kind === 'ping' ? 0.6 : 1 })
        .bindTooltip(players[m.k]?.name || '?', { permanent: true, direction: 'top' }).addTo(lg);
      if (m.kind === 'ping') L.circle([m.s.lat, m.s.lng], { radius: WALK_MS * (now - m.s.t) / 1000 + 10, color: c, dashArray: '4', weight: 1 }).addTo(lg);
    });
  }, [now]);

  const start = () => {
    if (!myPos) return setErr('Waiting for your GPS fix…');
    const r = {}; Object.keys(players).forEach(k => (r[k] = roles[k] || 'runner'));
    if (!Object.values(r).includes('hunter') || !Object.values(r).includes('runner')) return setErr('Need at least one Hunter and one Runner.');
    send('start', { cfg: { ...cfg, center: { lat: myPos.lat, lng: myPos.lng } }, roles: r });
  };
  const num = k => e => setCfg(c => ({ ...c, [k]: +e.target.value }));

  if (screen === 'home') return (
    <div className="wrap">
      <h1>Manhunt</h1><p className="dim">Real-world GPS chase. Stay on public land and away from traffic.</p>
      <input placeholder="Nickname" value={name} onChange={e => setName(e.target.value)} />
      <button onClick={() => join(uid().slice(0, 4).toUpperCase(), true)}>Create game</button>
      <div className="row"><input placeholder="Room code" value={codeIn} onChange={e => setCodeIn(e.target.value.toUpperCase())} />
        <button className="alt" onClick={() => join(codeIn, false)}>Join</button></div>
      <p className="err">{err}</p>
    </div>);

  if (screen === 'lobby') return (
    <div className="wrap">
      <h1>{code}</h1><p className="dim">Share this code. {myPos ? `GPS ready (±${Math.round(myPos.acc)} m)` : 'Waiting for GPS…'}</p>
      {Object.entries(players).map(([k, p]) => (
        <div className="player" key={k}><span>{p.name}{p.host ? ' (host)' : ''}</span>
          {isHost ? <button className={(roles[k] || 'runner') === 'hunter' ? 'red' : ''}
            onClick={() => setRoles(r => ({ ...r, [k]: (r[k] || 'runner') === 'runner' ? 'hunter' : 'runner' }))}>{roles[k] || 'runner'}</button> : null}
        </div>))}
      {isHost && <>
        <label className="dim">Zone radius (m)</label><input type="number" value={cfg.radius} onChange={num('radius')} />
        <label className="dim">Game length (min)</label><input type="number" value={cfg.duration} onChange={num('duration')} />
        <label className="dim">Runner ping every (sec)</label><input type="number" value={cfg.pingSec} onChange={num('pingSec')} />
        <label className="dim">Hunter position delay for runners (sec)</label><input type="number" value={cfg.delaySec} onChange={num('delaySec')} />
        <select value={cfg.convert ? 1 : 0} onChange={e => setCfg(c => ({ ...c, convert: e.target.value === '1' }))}>
          <option value={1}>Tagged runners become hunters</option><option value={0}>Tagged runners are eliminated</option></select>
        <p className="dim">The zone is centered on your current position.</p>
        <button onClick={start}>Start game</button></>}
      {!isHost && <p className="dim">Waiting for the host to start…</p>}
      <p className="err">{err}</p>
    </div>);

  const left = outside && outSince.current ? OUT_SEC - (now - outSince.current) / 1000 : 0;
  return (<>
    <div id="map" />
    <div className="hud top"><span>{now < startAt ? `Starts in ${Math.ceil((startAt - now) / 1000)}` : mmss((endAt - now) / 1000)}</span>
      <span>{myRole}</span><span>{runnersLeft} runner{runnersLeft === 1 ? '' : 's'} left</span></div>
    <div className="hud bottom">
      {playing && myRole === 'hunter' && <span>Next runner ping in {mmss((lastPing + interval - now) / 1000)}</span>}
      {outside && playing && <div className="warn">Outside the zone. Return in {Math.ceil(left)}s or you're out.</div>}
      {notice && <div className="warn">{notice}</div>}
      {playing && myRole === 'hunter' && <span className="dim">{nearest ? `Nearest runner: ${Math.round(nearest.d)} m (GPS ±${Math.round(myPos?.acc || 0)} m)` : 'No runner location received yet'}</span>}
      {target && <button className="red" onClick={() => { send('tagreq', { hunterId: id, runnerId: target, hunter: name }); setNotice('Waiting for runner to confirm…'); }}>Tag {players[target]?.name}</button>}
      {playing && myRole !== 'out' && <button className="alt" onClick={() => send('out', { id, to: 'out' })}>I'm out</button>}
      {myRole === 'out' && !over && <span className="dim">You're out. Spectating hunters' view.</span>}
    </div>
    {tagReq && <div className="modal"><div><h3>{tagReq.hunter} says they tagged you</h3>
      <button className="red" onClick={() => { send('out', { id, to: cfg.convert ? 'hunter' : 'out' }); send('tagres', { hunterId: tagReq.hunterId, ok: true }); setTagReq(null); }}>Yes, I'm tagged</button>
      <button className="alt" onClick={() => { send('tagres', { hunterId: tagReq.hunterId, ok: false }); setTagReq(null); }}>No</button></div></div>}
    {over && <div className="modal"><div><h2>{runnersLeft > 0 ? 'Runners win' : 'Hunters win'}</h2>
      {Object.entries(roles).map(([k, r]) => <div className="player" key={k}><span>{players[k]?.name || k}</span><span className="dim">{r}</span></div>)}
      <button onClick={() => location.reload()}>Back to home</button></div></div>}
  </>);
}