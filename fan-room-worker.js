const ALLOWED_ORIGIN = 'https://minatohiro-official.github.io';
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
    try {
      if (url.pathname === '/admin') return adminPage(request, env, url);
      if (url.pathname === '/admin/login' && request.method === 'POST') return login(request, env);
      if (url.pathname === '/admin/logout' && request.method === 'POST') return logout();
      if (url.pathname.startsWith('/admin/messages/') && request.method === 'POST') return updateMessageForm(request, env, url.pathname.split('/').pop());
      if (url.pathname === '/admin/messages' && request.method === 'GET') return adminMessages(request, env);
      if (url.pathname.startsWith('/admin/messages/') && request.method === 'PATCH') return updateMessage(request, env, url.pathname.split('/').pop());
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'v1' && parts[1] === 'artists' && parts[3] === 'replies' && request.method === 'GET') return publicReplies(request, env, parts[2]);
      if (parts[0] === 'v1' && parts[1] === 'artists' && parts[3] === 'messages' && request.method === 'POST') return createMessage(request, env, parts[2]);
      return json({ error: 'Not found' }, 404, request);
    } catch (error) {
      console.error(error);
      return json({ error: '一時的に処理できませんでした。' }, 500, request);
    }
  }
};

async function artist(env, slug) {
  return env.DB.prepare('SELECT id, slug, display_name FROM artists WHERE slug = ?').bind(slug).first();
}

async function createMessage(request, env, slug) {
  if (!isAllowedOrigin(request)) return json({ error: '許可されていない送信元です。' }, 403, request);
  const data = await request.json();
  if (data.website) return json({ ok: true }, 201, request);
  const target = await artist(env, slug);
  if (!target) return json({ error: '送信先が見つかりません。' }, 404, request);
  const category = String(data.category || '');
  const body = String(data.body || '').trim();
  const nickname = String(data.nickname || '匿名').trim().slice(0, 30) || '匿名';
  if (!['message', 'request', 'question'].includes(category) || body.length < 1 || body.length > 1200) return json({ error: '入力内容を確認してください。' }, 400, request);
  const key = await limitKey(request, env, target.id);
  const now = new Date().toISOString();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS submission_limits (key TEXT PRIMARY KEY, window_started_at TEXT NOT NULL, count INTEGER NOT NULL)').run();
  const limit = await env.DB.prepare('SELECT window_started_at, count FROM submission_limits WHERE key = ?').bind(key).first();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  if (limit && new Date(limit.window_started_at).getTime() > oneHourAgo && limit.count >= 3) return json({ error: '送信は1時間に3件までです。時間をおいてお試しください。' }, 429, request);
  if (limit && new Date(limit.window_started_at).getTime() > oneHourAgo) await env.DB.prepare('UPDATE submission_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  else await env.DB.prepare('INSERT INTO submission_limits (key, window_started_at, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_started_at = excluded.window_started_at, count = 1').bind(key, now).run();
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fan_messages (id, artist_id, category, nickname, body, allow_feature, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?, ?)').bind(id, target.id, category, nickname, body, data.allowFeature ? 1 : 0, now, now).run();
  return json({ ok: true }, 201, request);
}

async function publicReplies(request, env, slug) {
  const target = await artist(env, slug);
  if (!target) return json({ items: [] }, 404, request);
  const { results } = await env.DB.prepare('SELECT nickname, allow_feature, artist_reply, updated_at FROM fan_messages WHERE artist_id = ? AND status = \'approved\' AND reply_published = 1 AND artist_reply IS NOT NULL ORDER BY updated_at DESC LIMIT 12').bind(target.id).all();
  return json({ items: results.map(row => ({ nickname: row.allow_feature ? row.nickname : '匿名', reply: row.artist_reply, createdAt: row.updated_at })) }, 200, request);
}

async function login(request, env) {
  const type = request.headers.get('Content-Type') || '';
  const password = type.includes('application/json') ? (await request.json()).password : (await request.formData()).get('password');
  if (!env.ADMIN_PASSWORD || !same(String(password || ''), env.ADMIN_PASSWORD)) {
    if (!type.includes('application/json')) return redirect('/admin?error=password');
    return json({ error: 'パスワードが違います。' }, 401, request);
  }
  const token = await sessionToken(env);
  if (!type.includes('application/json')) return redirect('/admin', { 'Set-Cookie': `fan_room_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` });
  return json({ ok: true, token }, 200, request, { 'Set-Cookie': `fan_room_admin=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800` });
}

function logout() { return redirect('/admin', { 'Set-Cookie': 'fan_room_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' }); }

async function adminMessages(request, env) {
  if (!await signedIn(request, env)) return json({ error: 'Unauthorized' }, 401, request);
  const { results } = await env.DB.prepare('SELECT m.id, a.display_name, m.category, m.nickname, m.body, m.allow_feature, m.status, m.artist_reply, m.reply_published, m.created_at FROM fan_messages m JOIN artists a ON a.id = m.artist_id ORDER BY m.created_at DESC LIMIT 100').all();
  return json({ items: results }, 200, request);
}

async function updateMessage(request, env, id) {
  if (!await signedIn(request, env)) return json({ error: 'Unauthorized' }, 401, request);
  const data = await request.json();
  const status = ['pending', 'approved', 'archived'].includes(data.status) ? data.status : 'pending';
  const reply = String(data.reply || '').trim().slice(0, 1200) || null;
  const publish = data.publish && reply && status === 'approved' ? 1 : 0;
  await env.DB.prepare('UPDATE fan_messages SET status = ?, artist_reply = ?, reply_published = ?, updated_at = ? WHERE id = ?').bind(status, reply, publish, new Date().toISOString(), id).run();
  return json({ ok: true }, 200, request);
}

async function updateMessageForm(request, env, id) {
  if (!await signedIn(request, env)) return redirect('/admin?error=session');
  const data = await request.formData();
  const status = ['pending', 'approved', 'archived'].includes(data.get('status')) ? data.get('status') : 'pending';
  const reply = String(data.get('reply') || '').trim().slice(0, 1200) || null;
  const publish = data.get('publish') === 'on' && reply && status === 'approved' ? 1 : 0;
  await env.DB.prepare('UPDATE fan_messages SET status = ?, artist_reply = ?, reply_published = ?, updated_at = ? WHERE id = ?').bind(status, reply, publish, new Date().toISOString(), id).run();
  return redirect('/admin?saved=1');
}

async function limitKey(request, env, artistId) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${artistId}:${ip}:${env.RATE_LIMIT_SALT || 'fan-room'}`));
  return Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
}

async function sessionToken(env) {
  const payload = b64(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 }));
  return `${payload}.${await hmac(payload, env.SESSION_SECRET)}`;
}

async function signedIn(request, env) {
  const bearer = request.headers.get('Authorization') || '';
  const value = bearer.startsWith('Bearer ') ? bearer.slice(7) : (request.headers.get('Cookie') || '').match(/(?:^|; )fan_room_admin=([^;]+)/)?.[1];
  if (!value || !env.SESSION_SECRET) return false;
  const [payload, signature] = value.split('.');
  if (!payload || !signature || !same(signature, await hmac(payload, env.SESSION_SECRET))) return false;
  try { return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).exp > Date.now(); } catch { return false; }
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return b64(bytes);
}
function b64(value) { const bytes = typeof value === 'string' ? encoder.encode(value) : value; let s = ''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function same(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
function isAllowedOrigin(request) { return request.headers.get('Origin') === ALLOWED_ORIGIN; }
function corsHeaders(request) { return isAllowedOrigin(request) ? { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } : {}; }
function json(data, status, request, extra = {}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request), ...extra } }); }
function redirect(location, headers = {}) { return new Response(null, { status: 303, headers: { Location: location, ...headers } }); }
function escHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function adminPageLegacy() { return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FAN ROOM 管理</title><style>body{max-width:900px;margin:40px auto;padding:0 18px;background:#07080d;color:#eee;font-family:system-ui}input,textarea,select,button{box-sizing:border-box;width:100%;margin:6px 0;padding:10px;background:#141827;color:#fff;border:1px solid #ffffff33}button{cursor:pointer;color:#d7b777}.item{margin:18px 0;padding:18px;border:1px solid #ffffff22;white-space:pre-wrap}.hidden{display:none}</style><h1>FAN ROOM 管理</h1><section id="login-panel"><input id="pw" type="password" placeholder="管理パスワード"><button onclick="login()">ログイン</button><p id="err"></p></section><section id="app" class="hidden"><button onclick="logout()">ログアウト</button><div id="list"></div></section><script>const $=s=>document.querySelector(s);async function login(){let r=await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});if(!r.ok){$('#err').textContent='パスワードを確認してください';return}loginBox(false);load()}function loginBox(ok){$('#login-panel').classList.toggle('hidden',ok);$('#app').classList.toggle('hidden',!ok)}async function load(){let r=await fetch('/admin/messages');if(!r.ok)return;let d=await r.json();loginBox(true);$('#list').innerHTML=d.items.map(i=>'<article class="item"><small>'+i.display_name+' / '+i.category+' / '+i.created_at+'</small><h3>'+esc(i.nickname)+'</h3><p>'+esc(i.body)+'</p><label>状態</label><select id="s-'+i.id+'"><option value="pending" '+(i.status==='pending'?'selected':'')+'>確認中</option><option value="approved" '+(i.status==='approved'?'selected':'')+'>承認</option><option value="archived" '+(i.status==='archived'?'selected':'')+'>保管</option></select><label>返信</label><textarea id="r-'+i.id+'">'+esc(i.artist_reply||'')+'</textarea><label><input id="p-'+i.id+'" type="checkbox" '+(i.reply_published?'checked':'')+'>公開する</label><button onclick="save(\''+i.id+'\')">保存</button></article>').join('')}async function save(id){await fetch('/admin/messages/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:$('#s-'+id).value,reply:$('#r-'+id).value,publish:$('#p-'+id).checked})});load()}async function logout(){await fetch('/admin/logout',{method:'POST'});location.reload()}function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}load()</script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }

async function adminPage(request, env, url) {
  const shell = (content) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FAN ROOM 管理</title><style>body{max-width:900px;margin:40px auto;padding:0 18px;background:#07080d;color:#eee;font-family:system-ui}input,textarea,select,button{box-sizing:border-box;width:100%;margin:6px 0;padding:10px;background:#141827;color:#fff;border:1px solid #ffffff33}button{cursor:pointer;color:#d7b777}.item{margin:18px 0;padding:18px;border:1px solid #ffffff22;white-space:pre-wrap}.notice{color:#d7b777}.error{color:#f0aaa4}</style><h1>FAN ROOM 管理</h1>${content}`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (!await signedIn(request, env)) {
    const error = url.searchParams.get('error') === 'password' ? '<p class="error">パスワードを確認してください。</p>' : url.searchParams.get('error') === 'session' ? '<p class="error">セッションが切れました。もう一度ログインしてください。</p>' : '';
    return shell(`<form method="post" action="/admin/login"><input name="password" type="password" placeholder="管理パスワード" required autofocus><button type="submit">ログイン</button>${error}</form>`);
  }
  const { results } = await env.DB.prepare('SELECT m.id, a.display_name, m.category, m.nickname, m.body, m.status, m.artist_reply, m.reply_published, m.created_at FROM fan_messages m JOIN artists a ON a.id = m.artist_id ORDER BY m.created_at DESC LIMIT 100').all();
  const labels = { message: 'メッセージ', request: '歌唱リクエスト', question: '質問' };
  const items = results.map(i => `<article class="item"><small>${escHtml(i.display_name)} / ${escHtml(labels[i.category] || i.category)} / ${escHtml(i.created_at)}</small><h3>${escHtml(i.nickname)}</h3><p>${escHtml(i.body)}</p><form method="post" action="/admin/messages/${encodeURIComponent(i.id)}"><label>状態</label><select name="status"><option value="pending" ${i.status === 'pending' ? 'selected' : ''}>確認中</option><option value="approved" ${i.status === 'approved' ? 'selected' : ''}>承認</option><option value="archived" ${i.status === 'archived' ? 'selected' : ''}>保管</option></select><label>返信</label><textarea name="reply">${escHtml(i.artist_reply || '')}</textarea><label><input name="publish" type="checkbox" ${i.reply_published ? 'checked' : ''}>公開する</label><button type="submit">保存</button></form></article>`).join('') || '<p>まだメッセージはありません。</p>';
  const saved = url.searchParams.get('saved') === '1' ? '<p class="notice">保存しました。</p>' : '';
  return shell(`<form method="post" action="/admin/logout"><button type="submit">ログアウト</button></form>${saved}<div>${items}</div>`);
}
