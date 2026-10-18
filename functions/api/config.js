// แม่ฟื้นปลอดภัย · Cloudflare Pages Function: /api/config
// ค่ากลางที่ผู้ดูแลเปลี่ยนจากระยะไกล (เปิดหรือซ่อนภารกิจให้ทุกเครื่อง) เก็บใน KV ที่ผูกชื่อ MAEFUEN_KV
// การเปลี่ยนค่าต้องใช้รหัสผู้ดูแลจากตัวแปรลับ ADMIN_PIN
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const defaults = env => ({ missions: env.MISSIONS_DEFAULT === 'on', disabled: false, chatMode: 'strict' });

export async function onRequestGet({ env }) {
  const kv = env.MAEFUEN_KV;
  let cfg = null; try { cfg = kv ? await kv.get('config', 'json') : null; } catch (e) { cfg = null; }
  return json(200, Object.assign({}, defaults(env), cfg || {}, { persist: !!kv, adminReady: !!env.ADMIN_PIN }));
}

export async function onRequestPost({ request, env }) {
  const kv = env.MAEFUEN_KV, pin = env.ADMIN_PIN;
  let body = {}; try { body = await request.json(); } catch (e) { return json(400, { error: 'bad json' }); }
  if (!pin) return json(503, { error: 'ยังไม่ได้ตั้งรหัสผู้ดูแล ADMIN_PIN' });
  if (String(body.pin || '') !== pin) { await new Promise(r => setTimeout(r, 800)); return json(401, { error: 'รหัสผู้ดูแลไม่ถูกต้อง' }); }
  if (!kv) return json(500, { error: 'ยังไม่ได้ผูก KV ชื่อ MAEFUEN_KV กับโปรเจกต์' });
  let cur = {}; try { cur = (await kv.get('config', 'json')) || {}; } catch (e) { cur = {}; }
  if (typeof body.missions === 'boolean') cur.missions = body.missions;
  if (typeof body.disabled === 'boolean') cur.disabled = body.disabled;
  if (['strict', 'flex', 'free'].includes(body.chatMode)) cur.chatMode = body.chatMode;
  cur.updatedAt = new Date().toISOString();
  await kv.put('config', JSON.stringify(cur));
  return json(200, Object.assign({}, defaults(env), cur, { persist: true, adminReady: true }));
}
