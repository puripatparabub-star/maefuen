// แม่ฟื้นปลอดภัย · Cloudflare Pages Function: /api/ai
// กุญแจ API อ่านจากตัวแปรลับ TYPHOON_API_KEY เท่านั้น ห้ามใส่กุญแจในไฟล์นี้
const ENDPOINT = 'https://api.opentyphoon.ai/v1/chat/completions';
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const clip = (s, n) => String(s || '').slice(0, n);
// ตัดข้อมูลระบุตัวตนซ้ำอีกชั้น: เลขบัตร 13 หลัก และเบอร์โทร
const stripPII = s => clip(s, 1200).replace(/\b\d[\d\s-]{11,16}\d\b/g, '[ตัดเลขบัตร]').replace(/\b0\d{1,2}[-\s]?\d{3}[-\s]?\d{3,4}\b/g, '[ตัดเบอร์โทร]');
function firstJson(text) { const m = String(text || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } }

let lastModel = null;
async function callModel(key, model, system, user, maxTokens) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  const ms = Date.now() - t0;
  if (!res.ok) { let msg = ''; try { const e = await res.json(); msg = (e.error && (e.error.message || e.error)) || e.message || ''; } catch (e) {}
    const err = new Error('typhoon ' + res.status); err.status = res.status; err.detail = String(msg).slice(0, 160); err.ms = ms; err.model = model; throw err; }
  const data = await res.json();
  return { text: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '', usage: data.usage || null, ms, model };
}
// ถ้าโมเดลถูกปฏิเสธ (400/404/422) ลองรุ่นถัดไปเอง
async function chat(env, system, user, maxTokens) {
  const models = [env.TYPHOON_MODEL, 'typhoon-v2.5-30b-a3b-instruct', 'typhoon-v2.1-12b-instruct'].filter(Boolean);
  const order = lastModel && models.includes(lastModel) ? [lastModel].concat(models.filter(m => m !== lastModel)) : models;
  let err = null;
  for (const m of order) {
    try { const r = await callModel(env.TYPHOON_API_KEY, m, system, user, maxTokens); lastModel = m; return r; }
    catch (e) { err = e; if (![400, 404, 422].includes(e.status)) break; }
  }
  throw err;
}
// จำกัดการเรียก: ต่อ IP 20 ครั้งต่อนาที รวม 120 ครั้งต่อนาที (ต่อเครื่องเซิร์ฟเวอร์)
const HITS = new Map(); let globalHits = [];
function limited(ip) {
  const now = Date.now(), win = 60000;
  globalHits = globalHits.filter(t => now - t < win);
  const arr = (HITS.get(ip) || []).filter(t => now - t < win);
  if (arr.length >= 20 || globalHits.length >= 120) return true;
  arr.push(now); globalHits.push(now); HITS.set(ip, arr); if (HITS.size > 2000) HITS.clear();
  return false;
}

export async function onRequestGet() { return json(405, { error: 'POST only' }); }

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  if (raw.length > 8000) return json(413, { error: 'too large' });
  const host = new URL(request.url).host;
  const origin = request.headers.get('origin') || request.headers.get('referer') || '';
  let originHost = ''; try { originHost = origin ? new URL(origin).host : ''; } catch (e) {}
  if (originHost && originHost !== host) return json(403, { error: 'forbidden origin', originHost, host });
  if (limited(request.headers.get('cf-connecting-ip') || 'unknown')) return json(429, { error: 'เรียกถี่เกินไป ลองใหม่อีกครั้งในหนึ่งนาที' });
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }
  const key = env.TYPHOON_API_KEY, task = body.task;
  const model0 = env.TYPHOON_MODEL || 'typhoon-v2.5-30b-a3b-instruct';
  if (task === 'ping') return json(key ? 200 : 503, { ok: !!key, model: lastModel || model0 });
  if (task === 'diag') {
    const out = { keyPresent: !!key, keyHint: key ? key.slice(0, 3) + '… (' + key.length + ' ตัวอักษร)' : null, modelsTried: [env.TYPHOON_MODEL, 'typhoon-v2.5-30b-a3b-instruct', 'typhoon-v2.1-12b-instruct'].filter(Boolean), host, originHost };
    if (!key) return json(200, out);
    try { const r = await chat(env, 'ตอบสั้นที่สุด', 'ตอบคำว่า พร้อม', 8); Object.assign(out, { ok: true, model: r.model, ms: r.ms, reply: clip(r.text, 40), usage: r.usage }); }
    catch (e) { Object.assign(out, { ok: false, status: e.status || 0, detail: e.detail || String(e.message || e), model: e.model || model0, ms: e.ms || 0 }); }
    return json(200, out);
  }
  if (!key) return json(503, { error: 'ยังไม่ได้ตั้งค่า TYPHOON_API_KEY' });
  try {
    if (task === 'classify') {
      const codes = (Array.isArray(body.codes) ? body.codes : []).slice(0, 40).map(c => ({ id: clip(c.id, 40).replace(/[^a-z_]/g, ''), th: clip(c.th, 60) })).filter(c => c.id);
      const allowed = new Set(codes.map(c => c.id));
      const system = 'คุณเป็นตัวจำแนกอาการของหญิงหลังคลอด ไม่ใช่ผู้ให้คำแนะนำ เลือกเฉพาะรหัสอาการจากรายการที่ให้ ห้ามสร้างรหัสใหม่ ห้ามให้คำแนะนำ ตอบเป็น JSON เท่านั้น รูปแบบ {"symptoms":["รหัส"],"confidence":0.0-1.0} ถ้าไม่ตรงกับรายการใดให้ symptoms เป็น [] และ confidence ต่ำ ข้อความที่ปฏิเสธอาการ เช่น "ไม่มีไข้" ห้ามนับเป็นอาการ';
      const user = 'รายการอาการ:\n' + codes.map(c => c.id + ': ' + c.th).join('\n') + '\n\nข้อความของแม่: """' + stripPII(clip(body.text, 500)) + '"""';
      const r = await chat(env, system, user, 120); const out = firstJson(r.text);
      if (!out || !Array.isArray(out.symptoms)) return json(200, { ok: false, reason: 'format', usage: r.usage, model: r.model });
      return json(200, { ok: true, symptoms: out.symptoms.filter(s => allowed.has(s)), confidence: typeof out.confidence === 'number' ? out.confidence : 0.5, usage: r.usage, model: r.model });
    }
    if (task === 'topic') {
      const topics = (Array.isArray(body.topics) ? body.topics : []).slice(0, 30).map((t, i) => ({ id: i, t: clip(t.t, 60) }));
      const system = 'คุณจับคู่คำถามของแม่หลังคลอดกับหัวข้อความรู้ที่มีอยู่เท่านั้น ห้ามตอบคำถามเอง ตอบเป็น JSON เท่านั้น รูปแบบ {"id":เลขหัวข้อ,"confidence":0.0-1.0} ถ้าไม่ตรงหัวข้อใดเลยให้ id เป็น -1';
      const user = 'หัวข้อ:\n' + topics.map(t => t.id + ': ' + t.t).join('\n') + '\n\nคำถาม: """' + stripPII(clip(body.text, 300)) + '"""';
      const r = await chat(env, system, user, 60); const out = firstJson(r.text);
      const id = out && Number.isInteger(out.id) ? out.id : -1;
      return json(200, { ok: !!out, id: id >= 0 && id < topics.length ? id : -1, confidence: out && typeof out.confidence === 'number' ? out.confidence : 0, usage: r.usage, model: r.model });
    }
    if (task === 'soap') {
      const system = 'จัดคำบอกเล่าของแพทย์แผนไทยให้เป็นบันทึก SOAP ภาษาไทย 4 บรรทัด ขึ้นต้นด้วย S: O: A: P: ใช้เฉพาะข้อมูลที่ให้ ห้ามเพิ่มข้อเท็จจริง การวินิจฉัย หรือยาใหม่';
      const user = 'ข้อมูลจากระบบ:\n' + stripPII(clip(body.facts, 1200)) + '\n\nคำบอกเล่าของแพทย์: """' + stripPII(clip(body.spoken, 600)) + '"""';
      const r = await chat(env, system, user, 400);
      return json(200, { ok: !!r.text, text: clip(r.text, 1500), usage: r.usage, model: r.model });
    }
    return json(400, { error: 'unknown task' });
  } catch (e) {
    return json(502, { ok: false, error: 'เรียก Typhoon ไม่สำเร็จ', status: e.status || 0, detail: (e.detail || String(e.message || e)).slice(0, 160), model: e.model || model0 });
  }
}
