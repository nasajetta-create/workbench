/* 艋舺良的工作台 — 每朝簡報＋自動備份 Worker（WK0806-02）
 * cron: "0 23 * * *" = 台北 07:00 每朝簡報（ntfy 推播）
 *       "0 19 * * *" = 台北 03:00 自動備份（GitHub 私有 repo）
 * 環境變數：SA_KEY（GCP 服務帳戶 JSON，Secret）、GH_TOKEN（GitHub PAT，Secret）、
 *           NTFY_TOKEN（ntfy 存取權杖，Secret，選用——沒有也能跑）、
 *           NTFY_TOPIC、TEST_KEY（一般變數）
 * WK0806-02 變更：push() 改為三段式備援＋回報每一段的 HTTP 狀態，
 *   推播失敗不再靜默；支援 ntfy 帳號權杖以避開共用 IP 的匿名速率限制。
 */
const PROJECT = 'mengjia-workbench';
const BACKUP_REPO = 'nasajetta-create/workbench-backup';

export default {
  async scheduled(event, env, ctx){
    if (event.cron === '0 23 * * *') await brief(env);
    else if (event.cron === '0 19 * * *') await backup(env);
  },
  async fetch(req, env){
    const url = new URL(req.url);
    if (url.searchParams.get('key') !== env.TEST_KEY) return new Response('forbidden', {status:403});
    try{
      if (url.pathname === '/brief'){ const m = await brief(env); return new Response(m); }
      if (url.pathname === '/backup'){ const n = await backup(env); return new Response('備份完成：' + n); }
      return new Response('ok（/brief 或 /backup）');
    }catch(e){ return new Response('錯誤：' + e.message, {status:500}); }
  }
};

/* ── Google 服務帳戶取 token ── */
function b64url(bytes){
  let bin = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function gToken(env){
  const sa = JSON.parse(env.SA_KEY);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now()/1000);
  const data = enc({alg:'RS256',typ:'JWT'}) + '.' + enc({iss:sa.client_email, scope:'https://www.googleapis.com/auth/datastore', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600});
  const pem = sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const bin = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', bin.buffer, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data)));
  const jwt = data + '.' + b64url(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', {method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt});
  const j = await r.json();
  if (!j.access_token) throw new Error('取不到 Google token：' + JSON.stringify(j));
  return j.access_token;
}

/* ── Firestore 讀取 ── */
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
async function readColl(tok, coll){
  const out = []; let pageToken = '';
  do {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${coll}?pageSize=300` + (pageToken ? '&pageToken=' + pageToken : ''), {headers:{Authorization:'Bearer ' + tok}});
    const j = await r.json();
    (j.documents || []).forEach(d => { const o = dec(d.fields || {}); o._doc = d.name.split('/').pop(); out.push(o); });
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

/* ── 日期工具（台北時區） ── */
function tpe(d){ return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Taipei'}).format(d || new Date()); }
function dayDiff(dateStr){
  const t = new Date(tpe() + 'T00:00:00Z'), d = new Date(dateStr + 'T00:00:00Z');
  return Math.round((d - t) / 86400000);
}
const WD = ['日','一','二','三','四','五','六'];

/* ── 每朝簡報 ── */
async function brief(env){
  const tok = await gToken(env);
  const today = tpe(), y = today.slice(0,4);
  const [items, projects, bids, trips] = await Promise.all([
    readColl(tok, 'items_' + y), readColl(tok, 'projects'), readColl(tok, 'bids'), readColl(tok, 'trips')]);
  const L = [];
  /* 天氣 */
  try{
    const w = await fetch('https://api.open-meteo.com/v1/forecast?latitude=25.037&longitude=121.564&daily=weather_code,temperature_2m_max,precipitation_probability_max&timezone=Asia%2FTaipei&forecast_days=1').then(r => r.json());
    if (w.daily){
      const c = w.daily.weather_code[0], t = Math.round(w.daily.temperature_2m_max[0]), p = w.daily.precipitation_probability_max[0];
      const e = c===0?'☀':c<=3?'⛅':c<=48?'🌫':c<=67?'🌧':c<=77?'🌨':c<=82?'🌧':'⛈';
      L.push(`今天 ${e} ${t}°・降雨機率 ${p}%` + (p >= 50 ? '，記得帶雨具' : ''));
    }
  }catch(e){}
  /* 今日行程 */
  const evs = items.filter(i => !i.del && i.kind==='ev' && i.date === today)
    .sort((a,b) => (a.time||'') < (b.time||'') ? -1 : 1);
  if (evs.length) L.push('📅 今日：' + evs.map(e => (e.time ? e.time + ' ' : '') + e.title).join('、'));
  /* 到期待辦 */
  const tds = items.filter(i => !i.del && i.kind==='td' && !i.done && i.date && dayDiff(i.date) <= 0);
  if (tds.length) L.push('✅ 到期待辦：' + tds.map(t => t.title).join('、'));
  /* 投標關鍵日 */
  bids.filter(b => !b.del && !['won','lost'].includes(b.stage) && b.dates).forEach(b => {
    const c = b.dates.close, o = b.dates.open;
    if (c){ const n = dayDiff(c); if (n === 0) L.push('🔴 ' + b.name + ' 今天截標！'); else if (n > 0 && n <= 3) L.push('⚠ ' + b.name + ' 截標倒數 ' + n + ' 天'); }
    if (o && dayDiff(o) === 0) L.push('📣 ' + b.name + ' 今天開標');
  });
  /* 請款・保固 */
  projects.filter(p => !p.del).forEach(p => {
    (p.billing || []).forEach((bl, i) => {
      if (bl.due && bl.status !== '入帳' && dayDiff(bl.due) <= 0) L.push('💰 ' + p.name + ' 第' + (i+1) + '期可請款了');
    });
    if (p.status === 'warranty' && p.wEnd){ const n = dayDiff(p.wEnd); if (n >= 0 && n <= 30) L.push('🛡 ' + p.name + ' 保固剩 ' + n + ' 天' + (p.ret > 0 && !p.retOk ? '，保固金記得追' : '')); }
  });
  /* 旅程倒數 */
  trips.filter(t => !t.del && t.kind==='near' && !t.done && t.start).forEach(t => {
    const n = dayDiff(t.start);
    if (n === 0) L.push('✈ ' + t.name + ' 今天出發！');
    else if (n > 0 && n <= 14) L.push('✈ ' + t.name + ' 倒數 ' + n + ' 天');
  });
  if (L.length <= 1) L.push('今天沒有排定事項，安排點什麼吧 🍵');
  L.push('量個體重再出門 💪');
  const d = new Date(tpe() + 'T00:00:00Z');
  const msg = `${+today.slice(5,7)}/${+today.slice(8,10)}（${WD[d.getUTCDay()]}）\n` + L.join('\n');
  const how = await push(env, '早安，艋舺 👋 每朝簡報', msg);
  return '已推播（' + how + '）：\n' + msg;
}

/* ── ntfy 推播：三段式備援，失敗就吵 ── */
function b64ascii(str){
  const bytes = new TextEncoder().encode(str);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function push(env, title, msg){
  const H = {'User-Agent': 'mengjia-workbench/1.0'};
  if (env.NTFY_TOKEN) H.Authorization = 'Bearer ' + env.NTFY_TOKEN;
  const log = [];
  const attempt = async (label, url, opt) => {
    try{
      const r = await fetch(url, opt);
      if (r.ok){ log.push(label + '=ok'); return true; }
      log.push(label + '=' + r.status + ':' + (await r.text()).slice(0,120).replace(/\s+/g,' '));
    }catch(e){ log.push(label + '=ERR:' + e.message); }
    return false;
  };
  /* ① JSON 打根路徑（原本的做法） */
  if (await attempt('json', 'https://ntfy.sh/', {method:'POST',
    headers: Object.assign({}, H, {'Content-Type':'application/json'}),
    body: JSON.stringify({topic: env.NTFY_TOPIC, title, message: msg, tags: ['sunrise']})})) return log.join(' ');
  /* ② 純文字打 /主題（標題走 RFC2047 編碼，避開非 ASCII 標頭問題） */
  if (await attempt('text', 'https://ntfy.sh/' + env.NTFY_TOPIC, {method:'POST',
    headers: Object.assign({}, H, {'Content-Type':'text/plain; charset=utf-8',
      Title: '=?UTF-8?B?' + b64ascii(title) + '?=', Tags: 'sunrise'}),
    body: msg})) return log.join(' ');
  /* ③ /主題/publish，連標題都不帶（最陽春） */
  if (await attempt('publish', 'https://ntfy.sh/' + env.NTFY_TOPIC + '/publish', {method:'POST',
    headers: Object.assign({}, H, {'Content-Type':'text/plain; charset=utf-8'}),
    body: title + '\n' + msg})) return log.join(' ');
  throw new Error('ntfy 推播三種方式都失敗｜' + log.join(' ｜'));
}

/* ── 自動備份 ── */
function b64(str){
  const bytes = new TextEncoder().encode(str);
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
