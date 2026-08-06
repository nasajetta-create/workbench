/* 艋舺良的工作台 — 每朝簡報＋自動備份 Worker（WK0806-03）
 * cron: "0 23 * * *" = 台北 07:00 每朝簡報（Web Push 直接推到工作台 App）
 *       "0 19 * * *" = 台北 03:00 自動備份（GitHub 私有 repo）
 * 環境變數（機密）：SA_KEY（GCP 服務帳戶 JSON）、GH_TOKEN（GitHub PAT）、VAPID_KEY（VAPID 私鑰 PKCS8 base64）
 * 環境變數（純文字）：TEST_KEY
 * WK0806-03 變更：推播從 ntfy 改成 PWA 原生 Web Push（RFC 8188/8291/8292）。
 *   ntfy 免費版額度綁來源 IP，Cloudflare Worker 出口 IP 是共用的、永遠 429，因此棄用。
 *   加密實作已用 RFC 8291 §5 官方測試向量逐位元組比對通過。
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
  },
  async fetch(req, env){
    const url = new URL(req.url);
    if (url.searchParams.get('key') !== env.TEST_KEY) return new Response('forbidden', {status:403});
    try{
      if (url.pathname === '/brief'){ return new Response(await brief(env)); }
      if (url.pathname === '/backup'){ return new Response('備份完成：' + await backup(env)); }
      if (url.pathname === '/ping'){ return new Response(await ping(env)); }
      return new Response('ok（/brief、/backup 或 /ping）');
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
  const colls = ['projects','bids','clients','trips','weights','notes','meta',
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
