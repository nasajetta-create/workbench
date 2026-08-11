/* 艋舺良的工作台 — 每朝簡報＋自動備份＋Notion 鏡像 Worker（WK0811-02）
 * WK0811-02 變更：自動備份補上 W0811 新增的 recurs（固定收支）、loans（貸款）集合。
 * cron: "0 23 * * *" = 台北 07:00 每朝簡報（Web Push 直接推到工作台 App）
 *       "0 19 * * *" = 台北 03:00 自動備份（GitHub 私有 repo）
 *       "0 15 * * *" = 台北 23:00 Notion 鏡像同步（單向 工作台 → Notion）
 * 環境變數（機密）：SA_KEY（GCP 服務帳戶 JSON）、GH_TOKEN（GitHub PAT）、VAPID_KEY（VAPID 私鑰 PKCS8 base64）、
 *                   NOTION_KEY（Notion internal integration token，鏡像頁要先分享給該 integration）
 * 環境變數（純文字）：TEST_KEY
 * WK0806-03 變更：推播從 ntfy 改成 PWA 原生 Web Push（RFC 8188/8291/8292）。
 *   ntfy 免費版額度綁來源 IP，Cloudflare Worker 出口 IP 是共用的、永遠 429，因此棄用。
 *   加密實作已用 RFC 8291 §5 官方測試向量逐位元組比對通過。
 * WK0811-01 變更：新增 Notion 鏡像同步（③3a）。讀 Firestore → 以 wbid 對應 upsert 到
 *   Notion 五個資料庫（待辦/行事曆/投標/在建/筆記）；墓碑（del）→ 封存頁面；內容沒變就跳過不寫；
 *   重複 wbid 的多餘頁面自動封存。方向鐵律：單向 工作台→Notion，Notion 端手改會被覆蓋。
 */
const PROJECT = 'mengjia-workbench';
const BACKUP_REPO = 'nasajetta-create/workbench-backup';
const VAPID_PUB = 'BLm3fcUuRX5DSQqziOWr7F_2N4hgZN9sL2gF5dsGqiXw-bTa6A4dU2lUyChiKbvMb9RZkvUVSuFnrWwF4KuytO0';
const VAPID_SUB = 'mailto:nasa.jetta@gmail.com';
const APP_URL = 'https://nasajetta-create.github.io/workbench/';

export default {
  async scheduled(event, env, ctx){
    if (event.cron === '0 23 * * *') await brief(env);
    else if (event.cron === '0 19 * * *') await backup(env);
    else if (event.cron === '0 15 * * *') await notionSync(env);
  },
  async fetch(req, env){
    const url = new URL(req.url);
    if (url.searchParams.get('key') !== env.TEST_KEY) return new Response('forbidden', {status:403});
    try{
      if (url.pathname === '/brief'){ return new Response(await brief(env)); }
      if (url.pathname === '/backup'){ return new Response('備份完成：' + await backup(env)); }
      if (url.pathname === '/ping'){ return new Response(await ping(env)); }
      if (url.pathname === '/notion'){ return new Response(await notionSync(env)); }
      return new Response('ok（/brief、/backup、/ping 或 /notion）');
    }catch(e){ return new Response('錯誤：' + e.message, {status:500}); }
  }
};

/* ══════════ 共用小工具 ══════════ */
const ENC = new TextEncoder();
function b64url(bytes){
  let bin = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlDec(s){
  s = s.replace(/-/g,'+').replace(/_/g,'/');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function cat(...arrs){
  let n = 0; for (const a of arrs) n += a.length;
  const o = new Uint8Array(n); let i = 0;
  for (const a of arrs){ o.set(a, i); i += a.length; }
  return o;
}

/* ══════════ Google 服務帳戶取 token ══════════ */
async function gToken(env){
  const sa = JSON.parse(env.SA_KEY);
  const enc = o => b64url(ENC.encode(JSON.stringify(o)));
  const now = Math.floor(Date.now()/1000);
  const data = enc({alg:'RS256',typ:'JWT'}) + '.' + enc({iss:sa.client_email, scope:'https://www.googleapis.com/auth/datastore', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600});
  const pem = sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const bin = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', bin.buffer, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, ENC.encode(data)));
  const jwt = data + '.' + b64url(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', {method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt});
  const j = await r.json();
  if (!j.access_token) throw new Error('取不到 Google token：' + JSON.stringify(j));
  return j.access_token;
}

/* ══════════ Firestore ══════════ */
function decV(v){
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return +v.integerValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return dec(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decV);
  return null;
}
function dec(fields){ const o = {}; for (const k in fields) o[k] = decV(fields[k]); return o; }
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
async function readColl(tok, coll){
  const out = []; let pageToken = '';
  do {
    const r = await fetch(`${FS}/${coll}?pageSize=300` + (pageToken ? '&pageToken=' + pageToken : ''), {headers:{Authorization:'Bearer ' + tok}});
    const j = await r.json();
    (j.documents || []).forEach(d => { const o = dec(d.fields || {}); o._doc = d.name.split('/').pop(); out.push(o); });
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}
async function delDoc(tok, coll, id){
  await fetch(`${FS}/${coll}/${id}`, {method:'DELETE', headers:{Authorization:'Bearer ' + tok}});
}

/* ══════════ Web Push（RFC 8188 aes128gcm ＋ RFC 8292 VAPID） ══════════ */
async function hmac(keyBytes, data){
  const k = await crypto.subtle.importKey('raw', keyBytes, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function hkdf(salt, ikm, info, len){
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, cat(info, new Uint8Array([1])));
  return okm.slice(0, len);
}
async function encryptPayload(text, p256dh, auth){
  const uaPub = b64urlDec(p256dh), authSecret = b64urlDec(auth);
  const kp = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, {name:'ECDH', namedCurve:'P-256'}, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH', public: uaKey}, kp.privateKey, 256));
  const authInfo = cat(ENC.encode('WebPush: info'), new Uint8Array([0]), uaPub, asPub);
  const ikm = await hkdf(authSecret, ecdh, authInfo, 32);
  const cek = await hkdf(salt, ikm, cat(ENC.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, cat(ENC.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
  const plain = cat(ENC.encode(text), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv: nonce, tagLength:128}, aes, plain));
  return cat(salt, new Uint8Array([0,0,0x10,0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function vapidAuth(env, endpoint){
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now()/1000);
  const part = o => b64url(ENC.encode(JSON.stringify(o)));
  const data = part({typ:'JWT', alg:'ES256'}) + '.' + part({aud, exp: now + 12*3600, sub: VAPID_SUB});
  const raw = Uint8Array.from(atob(env.VAPID_KEY.trim()), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', raw, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, ENC.encode(data)));
  return 'vapid t=' + data + '.' + b64url(sig) + ', k=' + VAPID_PUB;
}
/* 推給所有已訂閱的裝置；失效的訂閱（404/410）自動從 Firestore 清掉 */
async function pushAll(env, tok, title, body){
  const subs = (await readColl(tok, 'pushsubs')).filter(s => !s.del && s.endpoint && s.p256dh && s.auth);
  if (!subs.length) return '沒有已訂閱的裝置——請先在工作台「設定」裡開啟每朝推播';
  const payload = JSON.stringify({title, body, url: APP_URL});
  const log = [];
  for (const s of subs){
    const tag = (s.name || s._doc || '裝置').slice(0, 12);
    try{
      const enc = await encryptPayload(payload, s.p256dh, s.auth);
      const r = await fetch(s.endpoint, {method:'POST', headers:{
        Authorization: await vapidAuth(env, s.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400', Urgency: 'normal'
      }, body: enc});
      log.push(tag + '=' + r.status);
      if (r.status === 404 || r.status === 410) { await delDoc(tok, 'pushsubs', s._doc); log.push(tag + ' 已失效·清除'); }
      else if (!r.ok) log.push(tag + '↩' + (await r.text()).slice(0,100).replace(/\s+/g,' '));
    }catch(e){ log.push(tag + '=ERR:' + e.message); }
  }
  return log.join(' ｜');
}

/* ══════════ 日期工具（台北時區） ══════════ */
function tpe(d){ return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Taipei'}).format(d || new Date()); }
function dayDiff(dateStr){
  const t = new Date(tpe() + 'T00:00:00Z'), d = new Date(dateStr + 'T00:00:00Z');
  return Math.round((d - t) / 86400000);
}
const WD = ['日','一','二','三','四','五','六'];

/* ══════════ 每朝簡報 ══════════ */
async function brief(env){
  const tok = await gToken(env);
  const today = tpe(), y = today.slice(0,4);
  const [items, projects, bids, trips] = await Promise.all([
    readColl(tok, 'items_' + y), readColl(tok, 'projects'), readColl(tok, 'bids'), readColl(tok, 'trips')]);
  const L = [];
  try{
    const w = await fetch('https://api.open-meteo.com/v1/forecast?latitude=25.037&longitude=121.564&daily=weather_code,temperature_2m_max,precipitation_probability_max&timezone=Asia%2FTaipei&forecast_days=1').then(r => r.json());
    if (w.daily){
      const c = w.daily.weather_code[0], t = Math.round(w.daily.temperature_2m_max[0]), p = w.daily.precipitation_probability_max[0];
      const e = c===0?'☀':c<=3?'⛅':c<=48?'🌫':c<=67?'🌧':c<=77?'🌨':c<=82?'🌧':'⛈';
      L.push(`今天 ${e} ${t}°・降雨機率 ${p}%` + (p >= 50 ? '，記得帶雨具' : ''));
    }
  }catch(e){}
  const evs = items.filter(i => !i.del && i.kind==='ev' && i.date === today)
    .sort((a,b) => (a.time||'') < (b.time||'') ? -1 : 1);
  if (evs.length) L.push('📅 今日：' + evs.map(e => (e.time ? e.time + ' ' : '') + e.title).join('、'));
  const tds = items.filter(i => !i.del && i.kind==='td' && !i.done && i.date && dayDiff(i.date) <= 0);
  if (tds.length) L.push('✅ 到期待辦：' + tds.map(t => t.title).join('、'));
  bids.filter(b => !b.del && !['won','lost'].includes(b.stage) && b.dates).forEach(b => {
    const c = b.dates.close, o = b.dates.open;
    if (c){ const n = dayDiff(c); if (n === 0) L.push('🔴 ' + b.name + ' 今天截標！'); else if (n > 0 && n <= 3) L.push('⚠ ' + b.name + ' 截標倒數 ' + n + ' 天'); }
    if (o && dayDiff(o) === 0) L.push('📣 ' + b.name + ' 今天開標');
  });
  projects.filter(p => !p.del).forEach(p => {
    (p.billing || []).forEach((bl, i) => {
      if (bl.due && bl.status !== '入帳' && dayDiff(bl.due) <= 0) L.push('💰 ' + p.name + ' 第' + (i+1) + '期可請款了');
    });
    if (p.status === 'warranty' && p.wEnd){ const n = dayDiff(p.wEnd); if (n >= 0 && n <= 30) L.push('🛡 ' + p.name + ' 保固剩 ' + n + ' 天' + (p.ret > 0 && !p.retOk ? '，保固金記得追' : '')); }
  });
  trips.filter(t => !t.del && t.kind==='near' && !t.done && t.start).forEach(t => {
    const n = dayDiff(t.start);
    if (n === 0) L.push('✈ ' + t.name + ' 今天出發！');
    else if (n > 0 && n <= 14) L.push('✈ ' + t.name + ' 倒數 ' + n + ' 天');
  });
  if (L.length <= 1) L.push('今天沒有排定事項，安排點什麼吧 🍵');
  L.push('量個體重再出門 💪');
  const d = new Date(tpe() + 'T00:00:00Z');
  const msg = `${+today.slice(5,7)}/${+today.slice(8,10)}（${WD[d.getUTCDay()]}）\n` + L.join('\n');
  const how = await pushAll(env, tok, '早安，艋舺 👋 每朝簡報', msg);
  return '推播結果：' + how + '\n\n' + msg;
}

/* ══════════ 測試推播（不含資料，只驗管線） ══════════ */
async function ping(env){
  const tok = await gToken(env);
  return await pushAll(env, tok, '工作台推播測試 🔔', '看得到這則就代表整條管線通了。\n' + new Date().toISOString());
}

/* ══════════ 自動備份 ══════════ */
function b64(str){
  const bytes = ENC.encode(str);
  let bin = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
async function ghPut(env, path, content, message){
  const url = `https://api.github.com/repos/${BACKUP_REPO}/contents/${path}`;
  const hdr = {Authorization:'Bearer ' + env.GH_TOKEN, 'User-Agent':'wb-backup', Accept:'application/vnd.github+json', 'Content-Type':'application/json'};
  let sha = null;
  const g = await fetch(url, {headers:hdr});
  if (g.ok){ sha = (await g.json()).sha; }
  const body = {message, content: b64(content)};
  if (sha) body.sha = sha;
  const r = await fetch(url, {method:'PUT', headers:hdr, body: JSON.stringify(body)});
  if (!r.ok) throw new Error('GitHub 寫入失敗 ' + r.status + '：' + (await r.text()).slice(0,200));
}
async function backup(env){
  const tok = await gToken(env);
  const today = tpe(), y = +today.slice(0,4);
  const data = {};
  const colls = ['projects','bids','clients','trips','weights','notes','meta','recurs','loans',
    'items_'+(y-1), 'items_'+y, 'items_'+(y+1), 'txs_'+(y-1), 'txs_'+y, 'txs_'+(y+1)];
  let total = 0;
  for (const c of colls){
    data[c] = await readColl(tok, c);
    total += data[c].length;
  }
  const json = JSON.stringify({at: new Date().toISOString(), project: PROJECT, data}, null, 1);
  await ghPut(env, 'backup/' + today + '.json', json, '自動備份 ' + today);
  await ghPut(env, 'latest.json', json, '自動備份 ' + today + '（latest）');
  return total + ' 筆・backup/' + today + '.json';
}

/* ══════════ Notion 鏡像同步（單向 工作台 → Notion） ══════════ */
const NOTION_VER = '2025-09-03';
const NOTION_DS = {
  td:       'f0b641f4-9c53-4831-ad03-866b67bf9246', // 待辦清單
  ev:       '7cf96821-7efa-4c79-b079-1b517856098b', // 行事曆
  bids:     'fb7081cb-11c8-45f5-a1a3-674574d52e85', // 投標案
  projects: '7ccd4893-dc08-45ed-9619-f29f8c1eac49', // 在建工程
  notes:    '20600505-22a1-4a2b-b95a-b2c59460cacb'  // 靈感筆記
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Notion REST；429 依 Retry-After 重試（最多 3 次） */
async function nApi(env, path, method, body){
  for (let i = 0; i < 3; i++){
    const r = await fetch('https://api.notion.com/v1' + path, {
      method: method || 'GET',
      headers: {Authorization:'Bearer ' + env.NOTION_KEY, 'Notion-Version':NOTION_VER, 'Content-Type':'application/json'},
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 429){ await sleep((+r.headers.get('Retry-After') || 2) * 1000); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error('Notion ' + r.status + '：' + (j.message || '').slice(0,150));
    return j;
  }
  throw new Error('Notion 429 連續三次，放棄');
}
/* 欄位值 → Notion property 物件（寫入用） */
const cut = (s, n) => String(s == null ? '' : s).slice(0, n || 1900);
const num = v => (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v;
function nProp(t, v){
  if (t === 'title')    return {title: v ? [{text:{content: cut(v)}}] : []};
  if (t === 'rich')     return {rich_text: v ? [{text:{content: cut(v)}}] : []};
  if (t === 'date')     return {date: v ? {start: v} : null};
  if (t === 'select')   return {select: v ? {name: v} : null};
  if (t === 'checkbox') return {checkbox: !!v};
  if (t === 'number')   return {number: num(v)};
}
/* Notion 頁面 property → 可比對的正規值（讀出用，跟寫入端同一空間） */
function nVal(t, p){
  if (!p) return t === 'checkbox' ? false : null;
  if (t === 'title')    return (p.title || []).map(x => x.plain_text).join('') || null;
  if (t === 'rich')     return (p.rich_text || []).map(x => x.plain_text).join('') || null;
  if (t === 'date')     return p.date && p.date.start ? p.date.start.slice(0,10) : null;
  if (t === 'select')   return p.select ? p.select.name : null;
  if (t === 'checkbox') return !!p.checkbox;
  if (t === 'number')   return (p.number === undefined || p.number === null) ? null : p.number;
}
/* 寫入端的正規值（跟 nVal 同一空間才能比對「有沒有變」） */
function dVal(t, v){
  if (t === 'checkbox') return !!v;
  if (t === 'number')   return num(v);
  if (t === 'date')     return v ? String(v).slice(0,10) : null;
  return v ? cut(v) : null; // title / rich / select
}
/* 同步一個資料庫：rows = [{wbid, del, fields:{欄名:[型別,值]}}] */
async function nSyncDb(env, name, ds, rows){
  // 1) 撈現有頁面，建 wbid → {id, page} 對照；重複 wbid 的多餘頁面直接封存
  const existing = new Map(); let cursor = null, extra = 0;
  do {
    const q = await nApi(env, '/data_sources/' + ds + '/query', 'POST',
      cursor ? {page_size:100, start_cursor:cursor} : {page_size:100});
    for (const pg of (q.results || [])){
      const id = nVal('rich', pg.properties && pg.properties.wbid);
      if (!id) continue;
      if (existing.has(id)){ await nApi(env, '/pages/' + pg.id, 'PATCH', {archived:true}); extra++; await sleep(250); }
      else existing.set(id, pg);
    }
    cursor = q.has_more ? q.next_cursor : null;
  } while (cursor);
  // 2) 逐筆 upsert
  let add = 0, upd = 0, del = 0, same = 0, err = 0; const errs = [];
  for (const row of rows){
    try{
      const pg = existing.get(row.wbid);
      if (row.del){
        if (pg){ await nApi(env, '/pages/' + pg.id, 'PATCH', {archived:true}); del++; await sleep(250); }
        continue; // 沒有對應頁就不用動
      }
      const changed = !pg || Object.keys(row.fields).some(k => {
        const [t, v] = row.fields[k];
        return JSON.stringify(dVal(t, v)) !== JSON.stringify(nVal(t, pg.properties && pg.properties[k]));
      });
      if (!changed){ same++; continue; }
      const props = {};
      for (const k in row.fields){ const [t, v] = row.fields[k]; props[k] = nProp(t, v); }
      if (pg){ await nApi(env, '/pages/' + pg.id, 'PATCH', {properties: props}); upd++; }
      else { await nApi(env, '/pages', 'POST', {parent:{type:'data_source_id', data_source_id: ds}, properties: props}); add++; }
      await sleep(250);
    }catch(e){ err++; if (errs.length < 3) errs.push(row.wbid + '：' + e.message); }
  }
  return name + '：新增' + add + ' 更新' + upd + ' 封存' + (del + extra) + ' 未變' + same +
    (err ? ' ⚠失敗' + err + '（' + errs.join('；') + '）' : '');
}
async function notionSync(env){
  if (!env.NOTION_KEY) return 'NOTION_KEY 未設定——請先在 Notion 建 internal integration、把鏡像頁分享給它，再把 token 存進 Cloudflare 環境變數';
  const tok = await gToken(env);
  const y = +tpe().slice(0,4);
  const [iA, iB, iC, projects, bids, notes] = await Promise.all([
    readColl(tok, 'items_' + (y-1)), readColl(tok, 'items_' + y), readColl(tok, 'items_' + (y+1)),
    readColl(tok, 'projects'), readColl(tok, 'bids'), readColl(tok, 'notes')]);
  const items = [...iA, ...iB, ...iC];
  const SCOPE = {site:'在建', case:'投標', life:'個人'};
  const STAGE = {prep:'領標備標', est:'估算中', sub:'已送標', open:'待開標', won:'得標', lost:'未得標'};
  const STATUS = {active:'進行中', warranty:'保固中', done:'已結案'};
  const L = [];
  L.push(await nSyncDb(env, '待辦', NOTION_DS.td, items.filter(i => i.kind === 'td' && i.id).map(i => ({
    wbid: i.id, del: !!i.del, fields: {
      '事項': ['title', i.title], '到期': ['date', i.date], '分類': ['select', SCOPE[i.scope] || null],
      '完成': ['checkbox', i.done], 'wbid': ['rich', i.id]}}))));
  L.push(await nSyncDb(env, '行事曆', NOTION_DS.ev, items.filter(i => i.kind === 'ev' && i.id).map(i => ({
    wbid: i.id, del: !!i.del, fields: {
      '事項': ['title', (i.time ? i.time + ' ' : '') + (i.title || '')], '日期': ['date', i.date],
      '分類': ['select', SCOPE[i.scope] || null], 'wbid': ['rich', i.id]}}))));
  L.push(await nSyncDb(env, '投標', NOTION_DS.bids, bids.filter(b => b._doc).map(b => ({
    wbid: b.id || b._doc, del: !!b.del, fields: {
      '案名': ['title', b.name], '階段': ['select', STAGE[b.stage] || null], '業主': ['rich', b.owner],
      '截標': ['date', b.dates && b.dates.close], '標價': ['number', b.amt],
      '押標金已退': ['checkbox', b.depRet], 'wbid': ['rich', b.id || b._doc]}}))));
  L.push(await nSyncDb(env, '在建', NOTION_DS.projects, projects.filter(p => p._doc).map(p => ({
    wbid: p.id || p._doc, del: !!p.del, fields: {
      '案名': ['title', p.name], '狀態': ['select', STATUS[p.status] || null], '進度': ['number', p.prog],
      '合約金額': ['number', p.contract], '保固到期': ['date', p.wEnd], 'wbid': ['rich', p.id || p._doc]}}))));
  L.push(await nSyncDb(env, '筆記', NOTION_DS.notes, notes.filter(n => n.id).map(n => ({
    wbid: n.id, del: !!n.del, fields: {
      '內容': ['title', n.txt], '標籤': ['rich', n.tag], '置頂': ['checkbox', n.pin], 'wbid': ['rich', n.id]}}))));
  return 'Notion 鏡像同步完成（' + tpe() + '）\n' + L.join('\n');
}
