/* 艋舺良的工作台 — 每朝簡報＋自動備份＋Notion 鏡像＋G95 報告 Worker（WK0817-03b）
 * WK0811-02 變更：自動備份補上 W0811 新增的 recurs（固定收支）、loans（貸款）集合。
 * WK0811-03 變更：自動備份補上健康管理的 bp（血壓）、allergy（藥物過敏）集合。
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
/* WK0816-01 變更：新增 G95 缺失修繕進度分析報告（週一三五 台北 07:30）。
 *   cron: "30 23 * * SUN,TUE,THU"（UTC 日二四 23:30 ＝ 台北 一三五 07:30；🔴 CF 星期欄不吃 0·用英文名）
 *   資料源＝g95-work 每日還原點 snaps/{日期}（單一 gzip 文件·今天沒有往前找 3 天）。
 *   送達＝①工作台 Web Push（既有管線）②Email（Resend·RESEND_KEY 未設就跳過）③GitHub 存 md（workbench-backup/g95report/）。
 *   前置＝g95-work IAM 把本服務帳戶加「Cloud Datastore 檢視者」（唯讀）。測試：/g95report?key=TEST_KEY
 */
const PROJECT = 'mengjia-workbench';
/* WK0817-01 變更：G95 報告加「報告網頁」/g95view——點推播直接開最新一期完整報告（內容＝Email 同一份）。
 *   報告 HTML 另存 workbench-backup/g95report/latest.html（ghPut 覆寫）；/g95view 用 ghGet 讀出直接回傳。
 *   pushAll 第 5 參數支援自訂點擊網址（sw.js 原本就會開 payload.url；工作台 App 開著時仍會聚焦 App＝已知小限制）。
 *   （WK0816-01b/01c：cron 前綴比對＋恆等式異常桶·詳接手筆記；0817 補存 cron＝儀表板存排程要重整驗證） */
const BACKUP_REPO = 'nasajetta-create/workbench-backup';
const VAPID_PUB = 'BLm3fcUuRX5DSQqziOWr7F_2N4hgZN9sL2gF5dsGqiXw-bTa6A4dU2lUyChiKbvMb9RZkvUVSuFnrWwF4KuytO0';
const VAPID_SUB = 'mailto:nasa.jetta@gmail.com';
const APP_URL = 'https://nasajetta-create.github.io/workbench/';

export default {
  async scheduled(event, env, ctx){
    if (event.cron === '0 23 * * *') await brief(env);
    else if (event.cron === '0 19 * * *') await backup(env);
    else if (event.cron === '0 15 * * *') await notionSync(env);
    else if (/^30 23 /.test(event.cron)) await g95Report(env);   // 台北一三五 07:30（儀表板存的是 SUN,TUE,THU 寫法·用前綴比對最穩）
  },
  async fetch(req, env){
    const url = new URL(req.url);
    if (url.searchParams.get('key') !== env.TEST_KEY) return new Response('forbidden', {status:403});
    try{
      if (url.pathname === '/brief'){ return new Response(await brief(env)); }
      if (url.pathname === '/backup'){ return new Response('備份完成：' + await backup(env)); }
      if (url.pathname === '/ping'){ return new Response(await ping(env)); }
      if (url.pathname === '/notion'){ return new Response(await notionSync(env)); }
      if (url.pathname === '/g95report'){ return new Response(await g95Report(env)); }
      if (url.pathname === '/g95zdebug'){   // WK0817-03b 偵錯用：看快照資料形狀·不寄信不推播
        const tok = await gToken(env); const {S, snapDate} = await g95Snap(tok);
        const rows = (S.rows || []); const z0 = (S.zones || [])[0] || null;
        const zn = {}; (S.zones || []).forEach(z => { if (z && (z.id || z.key)) zn[z.id || z.key] = String(z.name || '').trim(); });
        const hit = rows.filter(r => r && zn[r.zone]).length;
        return new Response(JSON.stringify({snapDate, zonesLen:(S.zones || []).length, zone0:z0, row0zone:rows[0] && rows[0].zone, znKeys:Object.keys(zn), hit, rowsLen:rows.length}, null, 1).slice(0, 3000), {headers:{'Content-Type':'application/json; charset=utf-8'}});
      }
      if (url.pathname === '/g95view'){
        const page = await ghGet(env, 'g95report/latest.html');
        return new Response(page || '報告尚未產生：等下一次排程發送，或先呼叫 /g95report 產生一份。',
          {status: page ? 200 : 404, headers: {'Content-Type': 'text/html; charset=utf-8'}});
      }
      return new Response('ok（/brief、/backup、/ping、/notion、/g95report 或 /g95view）');
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
async function pushAll(env, tok, title, body, url){
  const subs = (await readColl(tok, 'pushsubs')).filter(s => !s.del && s.endpoint && s.p256dh && s.auth);
  if (!subs.length) return '沒有已訂閱的裝置——請先在工作台「設定」裡開啟每朝推播';
  const payload = JSON.stringify({title, body, url: url || APP_URL});
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
async function ghGet(env, path){   // WK0817-01：讀 BACKUP_REPO 的檔案（UTF-8 文字），沒有回 null
  const r = await fetch(`https://api.github.com/repos/${BACKUP_REPO}/contents/${path}`,
    {headers:{Authorization:'Bearer ' + env.GH_TOKEN, 'User-Agent':'wb-backup', Accept:'application/vnd.github+json'}});
  if (!r.ok) return null;
  const j = await r.json();
  const bin = atob(String(j.content || '').replace(/\n/g,''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u8);
}
async function backup(env){
  const tok = await gToken(env);
  const today = tpe(), y = +today.slice(0,4);
  const data = {};
  const colls = ['projects','bids','clients','trips','weights','notes','meta','recurs','loans','bp','allergy',
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

/* ══════════ G95 缺失修繕進度分析報告（WK0816-01·週一三五 台北 07:30） ══════════
 * 🔴 判準照抄 G95 index.html（單一事實來源在 G95 那邊；G95 改口徑這裡要跟著改）：
 *    未完成＝compId==null｜產生日＝_wpDateMap/_wpAddDate 代理｜完成率＝狀態算（絕不流量相除）｜滾動 7 天窗
 *    恆等式自檢：doneNow ＝ donePrev＋近7天修掉＋完成缺日期，不成立會在報告裡標「⚠對帳異常」 */
const G95_FS = 'https://firestore.googleapis.com/v1/projects/g95-work/databases/(default)/documents';
const G95_URL = 'https://nasajetta-create.github.io/G95/';
const SELF_URL = 'https://still-fire-e099.nasa-jetta.workers.dev';
function addDaysISO(iso, n){ const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); }
async function g95Doc(tok, path){
  const r = await fetch(G95_FS + '/' + path, {headers:{Authorization:'Bearer ' + tok}});
  if (r.status === 404) return null;
  const j = await r.json();
  if (!r.ok) throw new Error('g95 讀取失敗 ' + r.status + '（多半是 IAM 還沒把服務帳戶加進 g95-work）：' + JSON.stringify(j).slice(0,150));
  return dec(j.fields || {});
}
/* 每日還原點：今天沒有就往前找（最多 3 天）；支援 _p1/_p2 分片 */
async function g95Gz(z){   // WK0817-03b：base64+gzip 解回文字（snap 與 meta 共用）
  const bytes = Uint8Array.from(atob(String(z)), c => c.charCodeAt(0));
  return await new Response(new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))).text();
}
async function g95Snap(tok){
  for (let back = 0; back <= 3; back++){
    const ds = addDaysISO(tpe(), -back);
    const d = await g95Doc(tok, 'projects/main/snaps/' + ds);
    if (!d) continue;
    let z = d.z || '';
    if (d.parts > 1){ z = ''; for (let i = 1; i <= d.parts; i++){ const p = await g95Doc(tok, 'projects/main/snaps/' + ds + '_p' + i); z += (p && p.z) || ''; } }
    if (!z) continue;
    const txt = await g95Gz(z);
    return {S: JSON.parse(txt), snapDate: ds, by: d.by || ''};
  }
  throw new Error('找不到近 3 天的每日還原點（snaps）——G95 當天要有人開過才會建快照');
}
/* ── 判準移植（逐字對齊 G95 的 _wpUnitOf/_irRound/inspTypeOf/_wpDateMap/_wpAddDate）── */
function g95UnitOf(r){
  const u = String((r && r.unit) || '').replace(/^(地|業)/,'').replace(/[（(][^）)]*[）)]/g,'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
  const f = String((r && r.floor) || '').replace(/\D/g,'');
  return u + (f ? ('-' + f) : '');
}
function g95InspType(ins){
  if (ins && ins.type) return ins.type;
  const l = String((ins && ins.label) || '');
  if (/初驗/.test(l)) return '初驗';
  const m = l.match(/複驗\s*(\d+)/);
  return m ? ('複驗' + m[1]) : '初驗';
}
function g95Round(r){ const v = String((r && r.round) || '').trim(); if (!v) return '初驗'; if (v === '複驗') return '複驗1'; return v; }
function g95DateMap(S){
  const HU = S.handoverUnits || {}, m = {};
  Object.keys(HU).forEach(k => {
    const u = String(k).replace(/^(地|業)/,''), o = {};
    ((HU[k] || {}).inspections || []).forEach(i => {
      if (!i || !i.date) return; const t = g95InspType(i);
      if (!o[t] || i.date < o[t]) o[t] = i.date;
    });
    m[u] = o;
  });
  return m;
}
function g95AddDate(r, dmap){
  const o = dmap[g95UnitOf(r)] || {};
  let d = o[g95Round(r)] || o['初驗'] || '';
  if (!d && r && r.createdAt){ try{ d = tpe(new Date(r.createdAt)); }catch(e){} }
  return d || '';
}
/* ── WoW（與 G95 _ulqWoW 同邏輯）：list = [{r,done}] ── */
function g95WoW(list, dmap, base){
  let fixed=0, added=0, pendNow=0, pendPrev=0, exPrev=0, doneNow=0, donePrev=0, noDate=0, exNow=0, anom=0;
  for (const it of list){
    const r = it.r, dn = it.done, dd = r.actualDone || '';
    let ad = ''; try{ ad = g95AddDate(r, dmap); }catch(e){}
    const exP = (!ad || ad <= base), dnP = dn && dd && dd <= base;
    exNow++;
    if (dn){ doneNow++; if (!dd) noDate++; } else pendNow++;
    if (exP){ exPrev++; if (dnP) donePrev++; else pendPrev++; }
    if (dn && dd && dd > base) fixed++;
    if (ad && ad > base) added++;
    if (dn && dd && dd <= base && ad && ad > base) anom++;   // 完成日早於產生日（V0813-06 已知異常類·自檢/舊資料）
  }
  const rN = exNow ? Math.round(doneNow * 100 / exNow) : 0;
  const rP = exPrev ? Math.round(donePrev * 100 / exPrev) : 0;
  return {fixed, added, pendPrev, pendNow, ratePrev:rP, rateNow:rN, diff:rN-rP, doneNow, donePrev, noDate, anom, ok:(doneNow === donePrev + fixed + noDate + anom)};
}
const g95Pct = w => `${w.ratePrev}%→${w.rateNow}%（${w.diff>=0?'+':''}${w.diff}）`;
/* ── Email（Resend；未設 RESEND_KEY 就跳過） ── */
async function g95Mail(env, subject, html){
  if (!env.RESEND_KEY) return 'Email：RESEND_KEY 未設定＝略過';
  const r = await fetch('https://api.resend.com/emails', {method:'POST',
    headers:{Authorization:'Bearer ' + env.RESEND_KEY, 'Content-Type':'application/json'},
    body: JSON.stringify({from:'G95 報告 <onboarding@resend.dev>', to:['nasa.jetta@gmail.com'], subject, html})});
  return 'Email：' + r.status + (r.ok ? '' : ('·' + (await r.text()).slice(0,120)));
}
/* ── 主流程 ── */
async function g95Report(env){
  const tok = await gToken(env);
  const {S, snapDate} = await g95Snap(tok);
  const today = tpe(), base = addDaysISO(today, -7);
  const wd = WD[new Date(today + 'T00:00:00Z').getUTCDay()];
  const voidRow = r => !String((r && r.issue) || '').trim();
  const rows = (S.rows || []).filter(r => !voidRow(r));
  const comp = (S.completed || []).filter(r => !voidRow(r));
  const list = rows.map(r => ({r, done:(r.compId != null)})).concat(comp.map(r => ({r, done:true})));
  const dmap = g95DateMap(S);
  const overall = g95WoW(list, dmap, base);
  // ── 分區（WK0817-03·判準＝G95 分區欄位 r.zone·單一事實來源見《報告分區改版_規格_0817》）──
  // WK0817-03b：每日快照不帶 S.zones（0817 真資料實測全掉未分類）→ 退路＝讀雲端 meta 原始文件取分區定義
  if (!Array.isArray(S.zones) || !S.zones.length){
    try{
      const md = await g95Doc(tok, 'projects/main/_fields/meta');
      let M = null;
      if (md && md.z) M = JSON.parse(await g95Gz(md.z));
      else if (md && md.d) M = JSON.parse(md.d);
      if (M && Array.isArray(M.zones) && M.zones.length) S.zones = M.zones;
    }catch(e){}
  }
  const zName = {}; (S.zones || []).forEach(z => { if (z && (z.id || z.key)) zName[z.id || z.key] = String(z.name || '').trim(); });
  const zGrpOf = n => !n ? '未分類' : (/室內|店鋪/.test(n) ? '室內' : (/公設|地下室/.test(n) ? '公設' : '其他'));
  const grpMap = new Map([['室內',[]],['公設',[]],['其他',[]],['未分類',[]]]);
  const subMap = new Map();
  for (const it of list){
    const n = zName[it.r.zone] || '';
    const g = zGrpOf(n); grpMap.get(g).push(it);
    const sub = n || '未分類';
    if (!subMap.has(sub)) subMap.set(sub, {g, ls: []});
    subMap.get(sub).ls.push(it);
  }
  const gW = {}; for (const [g, ls] of grpMap) gW[g] = g95WoW(ls, dmap, base);
  const IW = gW['室內'], PW = gW['公設'];
  const gOrder = ['室內','公設','其他','未分類'];
  const subs = [...subMap.entries()].map(([name, o]) => ({name, g: o.g, w: g95WoW(o.ls, dmap, base)}))
    .filter(s => s.w.pendNow > 0 || s.w.fixed > 0 || s.w.added > 0)
    .sort((a, b) => gOrder.indexOf(a.g) - gOrder.indexOf(b.g) || b.w.pendNow - a.w.pendNow);
  const zSum = gOrder.reduce((a, g) => a + gW[g].pendNow, 0);
  const zWarn = (zSum === overall.pendNow) ? '' : `\n⚠ 分區對帳異常（分區合計 ${zSum} ≠ 總體 ${overall.pendNow}），請回報維護者`;
  // ── 廠商（還欠多 → 少·可依範圍算）──
  const vendOf = ls => { const m = new Map();
    for (const it of ls){ const v = String(it.r.vendor || '').trim() || '（未填廠商）'; if (!m.has(v)) m.set(v, []); m.get(v).push(it); }
    return [...m.entries()].map(([name, l]) => ({name, pend: l.filter(x => !x.done).length, w: g95WoW(l, dmap, base)}))
      .filter(v => v.pend > 0 || v.w.fixed > 0 || v.w.added > 0).sort((a, b) => b.pend - a.pend); };
  const vend = vendOf(list), vendIn = vendOf(grpMap.get('室內')), vendPub = vendOf(grpMap.get('公設'));
  // ── 複驗批（兩邊都去掉 地/業 字首與尾碼 F 再比對；批＝戶＝室內）──
  const norm = k => String(k || '').replace(/^(地|業)/,'').replace(/F$/i,'');
  const uf = S.reCheckUF || {}; const byD = new Map();
  Object.keys(uf).forEach(k => { const d = uf[k]; if (!d) return; if (!byD.has(d)) byD.set(d, new Set()); byD.get(d).add(norm(k)); });
  const zones = [...byD.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([d, set]) => {
    const ls = list.filter(it => set.has(g95UnitOf(it.r)));
    return {d, n: set.size, w: g95WoW(ls, dmap, base)};
  });
  const warn = (overall.ok && vend.every(v => v.w.ok)) ? '' : '\n⚠ 對帳異常（doneNow≠donePrev+修掉+缺日期+早於產生），數字僅供參考，請回報維護者';
  const anomNote = overall.anom ? `\n（註：${overall.anom} 筆完成日早於產生日的舊資料已計入完成數·V0813-06 同類異常）` : '';
  // ── LINE 貼上用純文字（室內第一行·分區小計）──
  const T = [];
  T.push(`G95 修繕進度報告 ${+today.slice(5,7)}/${+today.slice(8,10)}（${wd}）·資料時點 ${snapDate}`);
  T.push(`■ 室內：未完成 ${IW.pendNow}（上週 ${IW.pendPrev}）｜近7天 修掉 ${IW.fixed}·新增 ${IW.added}｜完成率 ${g95Pct(IW)}`);
  T.push(`■ 總體：未完成 ${overall.pendNow}（上週 ${overall.pendPrev}）｜近7天 修掉 ${overall.fixed}·新增 ${overall.added}｜完成率 ${g95Pct(overall)}`);
  T.push('■ 分區：');
  subs.forEach(s => T.push(`  ${s.name}｜欠 ${s.w.pendNow}｜修 ${s.w.fixed} 新 ${s.w.added}｜${g95Pct(s.w)}`));
  if (zones.length){
    T.push('■ 複驗批：');
    zones.forEach(z => T.push(`  複驗 ${z.d.slice(5).replace('-','/')}·${z.n}戶｜修 ${z.w.fixed} 新 ${z.w.added}｜未完成 ${z.w.pendPrev}→${z.w.pendNow}`));
  }
  T.push('■ 廠商（還欠多→少·前10）：');
  vend.slice(0,10).forEach(v => T.push(`  ${v.name}｜欠 ${v.pend}｜修 ${v.w.fixed} 新 ${v.w.added}｜${g95Pct(v.w)}`));
  if (vend.length > 10) T.push(`  …另 ${vend.length-10} 家（合計欠 ${vend.slice(10).reduce((a,v)=>a+v.pend,0)}）——完整見 Email`);
  const lineTxt = T.join('\n') + anomNote + warn + zWarn;
  // ── HTML 零件 ──
  const td = 'border:1px solid #cdd5df;padding:5px 9px;font-size:13px';
  const th = td + ';background:#EAF1FB;font-weight:700';
  const sumTd = td + ';background:#F0F4EA;font-weight:700';
  const pct = w => g95Pct(w);
  const heroH = (label, w, subLine) => `<div style="border:1px solid #A9CBE8;background:#EAF4FC;padding:10px 14px;font-size:15px;margin-bottom:6px">
${label}未完成 <b style="font-size:22px;color:#B3261E">${w.pendNow}</b> 筆（上週 ${w.pendPrev}）　近 7 天修掉 <b>${w.fixed}</b>·新增 <b>${w.added}</b>　完成率 <b>${pct(w)}</b>
<div style="font-size:13px;color:#555;margin-top:4px">${subLine}</div></div>`;
  const allSub = `全工地：未完成 ${overall.pendNow}（上週 ${overall.pendPrev}）·修掉 ${overall.fixed}·新增 ${overall.added}·完成率 ${pct(overall)}`;
  const zTr = (name, w, sum, indent) => `<tr><td style="${sum?sumTd:td}${indent?';padding-left:26px':''}">${name}</td><td style="${sum?sumTd:td};text-align:right">${sum?'<b>'+w.pendNow+'</b>':w.pendNow}</td><td style="${sum?sumTd:td};text-align:right">${w.fixed}</td><td style="${sum?sumTd:td};text-align:right">${w.added}</td><td style="${sum?sumTd:(w.diff<0?td+';background:#FCF0F0':td)}">${pct(w)}</td></tr>`;
  let zTbl = `<h3 style="margin:12px 0 6px;font-size:15px">分區小計</h3><table style="border-collapse:collapse"><tr><th style="${th}">分區</th><th style="${th}">還欠</th><th style="${th}">修掉</th><th style="${th}">新增</th><th style="${th}">完成率</th></tr>`;
  zTbl += zTr('室內小計', IW, true, false);
  subs.filter(s => s.g === '室內').forEach(s => zTbl += zTr(s.name, s.w, false, true));
  zTbl += zTr('公設小計', PW, true, false);
  subs.filter(s => s.g === '公設').forEach(s => zTbl += zTr(s.name, s.w, false, true));
  if (gW['其他'].pendNow > 0 || gW['其他'].fixed > 0){ zTbl += zTr('其他小計', gW['其他'], true, false); subs.filter(s => s.g === '其他').forEach(s => zTbl += zTr(s.name, s.w, false, true)); }
  if (gW['未分類'].pendNow > 0 || gW['未分類'].fixed > 0) zTbl += zTr('⚠未分類（缺分區·請回 G95 補）', gW['未分類'], true, false);
  zTbl += '</table>';
  const vTbl = (arr, title) => `<h3 style="margin:14px 0 6px;font-size:15px">${title}（還欠多→少·紅底＝完成率倒退）</h3>
<table style="border-collapse:collapse"><tr><th style="${th}">#</th><th style="${th}">廠商</th><th style="${th}">還欠</th><th style="${th}">修掉</th><th style="${th}">新增</th><th style="${th}">完成率</th></tr>${arr.map((v,i) => `<tr${v.w.diff<0?' style="background:#FCF0F0"':''}><td style="${td}">${i+1}</td><td style="${td}">${v.name}</td><td style="${td};text-align:right"><b>${v.pend}</b></td><td style="${td};text-align:right">${v.w.fixed}</td><td style="${td};text-align:right">${v.w.added}</td><td style="${td}">${pct(v.w)}</td></tr>`).join('')}</table>`;
  const zonesH = zones.map(z => `<tr><td style="${td}">複驗 ${z.d.slice(5).replace('-','/')}</td><td style="${td};text-align:right">${z.n}</td><td style="${td};text-align:right">${z.w.fixed}</td><td style="${td};text-align:right">${z.w.added}</td><td style="${td}">${z.w.pendPrev}→${z.w.pendNow}</td><td style="${td}">${pct(z.w)}</td></tr>`).join('');
  const batchTbl = zones.length ? `<h3 style="margin:12px 0 6px;font-size:15px">複驗批進度</h3><table style="border-collapse:collapse"><tr><th style="${th}">批</th><th style="${th}">戶</th><th style="${th}">修掉</th><th style="${th}">新增</th><th style="${th}">未完成</th><th style="${th}">完成率</th></tr>${zonesH}</table>` : '';
  const headH = `<h2 style="margin:0 0 4px">G95 缺失修繕進度分析報告</h2>
<div style="color:#666;font-size:13px;margin-bottom:12px">${today}（${wd}）·資料時點 ${snapDate} 快照·滾動 7 天窗（基準 ${base}）${(warn||zWarn)?'<b style="color:#B3261E">'+warn+zWarn+'</b>':''}</div>`;
  const lineBox = `<h3 style="margin:16px 0 6px;font-size:15px">LINE 貼上用</h3>
<pre style="background:#F6F5F2;border:1px solid #d8d5cd;padding:10px;font-size:12px;white-space:pre-wrap">${lineTxt}</pre>`;
  const footH = `<div style="color:#999;font-size:11px;margin-top:10px">口徑＝G95 畫面同一把尺（未完成＝未銷案·完成率用狀態算·滾動 7 天）·分區判準＝G95 分區欄位·<a href="${G95_URL}">開啟 G95</a></div>`;
  // ── Email（靜態＝室內優先＋分區表＋全部廠商）──
  const html = `<div style="font-family:'Microsoft JhengHei',sans-serif;max-width:720px">${headH}${heroH('室內', IW, allSub)}${zTbl}${batchTbl}${vTbl(vend, '各廠商（全工地）')}${lineBox}${footH}</div>`;
  // ── /g95view 報告頁（可切換 全部｜室內｜公設·預設室內）──
  const pubNote = `<div style="border:1px solid #d8d5cd;background:#F6F5F2;padding:12px;font-size:13px;color:#666;margin:12px 0">公設沒有複驗批</div>`;
  const viewBody = `<div style="font-family:'Microsoft JhengHei',sans-serif;max-width:760px">${headH}
<div style="margin:4px 0 12px"><button class="scb" data-sc="in" style="padding:7px 22px;font-size:14px;border:1px solid #9aa7b8;background:#fff;cursor:pointer">室內</button><button class="scb" data-sc="all" style="padding:7px 22px;font-size:14px;border:1px solid #9aa7b8;background:#fff;cursor:pointer">全部</button><button class="scb" data-sc="pub" style="padding:7px 22px;font-size:14px;border:1px solid #9aa7b8;background:#fff;cursor:pointer">公設</button></div>
<div class="sc sc-in">${heroH('室內', IW, allSub)}</div>
<div class="sc sc-all">${heroH('全工地', overall, `室內：未完成 ${IW.pendNow}·修掉 ${IW.fixed}·${pct(IW)}　公設：未完成 ${PW.pendNow}·修掉 ${PW.fixed}·${pct(PW)}`)}</div>
<div class="sc sc-pub">${heroH('公設', PW, allSub)}</div>
${zTbl}
<div class="sc sc-in sc-all">${batchTbl}</div>
<div class="sc sc-pub">${pubNote}</div>
<div class="sc sc-in">${vTbl(vendIn, '各廠商（室內）')}</div>
<div class="sc sc-all">${vTbl(vend, '各廠商（全工地）')}</div>
<div class="sc sc-pub">${vTbl(vendPub, '各廠商（公設）')}</div>
${lineBox}${footH}</div>
<script>
(function(){
  function setSc(sc){
    document.querySelectorAll('.sc').forEach(function(el){ el.style.display = el.classList.contains('sc-'+sc) ? '' : 'none'; });
    document.querySelectorAll('.scb').forEach(function(b){ var on = b.getAttribute('data-sc')===sc;
      b.style.background = on ? '#1c3f77' : '#fff'; b.style.color = on ? '#fff' : '#222'; b.style.fontWeight = on ? '700' : '400'; });
    try{ localStorage.setItem('g95view_sc', sc); }catch(e){}
  }
  document.querySelectorAll('.scb').forEach(function(b){ b.addEventListener('click', function(){ setSc(b.getAttribute('data-sc')); }); });
  var sc = 'in'; try{ sc = localStorage.getItem('g95view_sc') || 'in'; }catch(e){}
  if (['in','all','pub'].indexOf(sc) < 0) sc = 'in';
  setSc(sc);
})();
</script>`;
  // ── 送達 ──
  const log = [];
  log.push('分區偵錯：zones=' + ((S.zones || []).length) + '·rows帶zone=' + rows.filter(r => r && r.zone).length + '/' + rows.length + '·comp帶zone=' + comp.filter(r => r && r.zone).length + '/' + comp.length + '｜zone0=' + JSON.stringify((S.zones || [])[0] || null).slice(0, 120) + '｜row0.zone=' + JSON.stringify(rows[0] && rows[0].zone) + '｜zName鍵=' + Object.keys(zName).slice(0, 5).join(','));
  log.push(await g95Mail(env, `G95 修繕進度 ${today}：室內未完成 ${IW.pendNow}·修掉 ${IW.fixed}（${IW.diff>=0?'+':''}${IW.diff}）`, html));
  try{ await ghPut(env, 'g95report/latest.html',
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>G95 修繕進度報告 ${today}</title></head><body style="margin:12px;background:#fff">${viewBody}</body></html>`,
    'G95 報告頁 ' + today); log.push('報告頁：/g95view 已更新'); }
  catch(e){ log.push('報告頁：' + e.message); }
  log.push('推播：' + await pushAll(env, tok, 'G95 修繕進度報告',
    `室內未完成 ${IW.pendNow}（上週 ${IW.pendPrev}）·修掉 ${IW.fixed}·完成率 ${pct(IW)}\n全工地 ${overall.pendNow}·點開看完整報告`,
    APP_URL + 'g95view.html#k=' + env.TEST_KEY));
  try{ await ghPut(env, 'g95report/' + today + '.md', lineTxt, 'G95 報告 ' + today); log.push('GitHub：已存 g95report/' + today + '.md'); }
  catch(e){ log.push('GitHub：' + e.message); }
  return log.join('\n') + '\n\n' + lineTxt;
}
