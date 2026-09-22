/* ==========================================================================
   /api/referido  —  Función serverless (Vercel, Node runtime)
   --------------------------------------------------------------------------
   Recibe una recomendación del "Trae a un colega" de Atlas y:
     1. LEE en HubSpot el negocio del alumno que recomienda y saca su
        propietario (el comercial asignado).  ← solo lectura, no escribe nada.
     2. Avisa por Slack al canal, con @mención al comercial, incluyendo los
        datos del colega (que vienen del propio formulario).

   No escribe en HubSpot: los datos del colega salen del formulario y el único
   dato que consultamos es el comercial del alumno. Por eso basta un token de
   CRM de solo lectura, y nunca se tocan FP ni oposiciones.

   Variables de entorno (Vercel → Project → Settings → Environment Variables):
     HUBSPOT_TOKEN                   (opc.) Private App token (CRM read).
                                           Scopes: crm.objects.contacts.read,
                                           crm.objects.deals.read,
                                           crm.objects.owners.read
     HUBSPOT_ACCESO_UNI_PIPELINE_ID  (opc.) Si se define, prioriza el negocio
                                           del alumno en ESE pipeline para sacar
                                           el comercial (recomendado).

   Avisos a Slack — canal destino: ID C0BL7G1CMU6 (workspace ucademyespacio)
     A) Bot token (recomendado):
        SLACK_BOT_TOKEN   xoxb-...   scopes: chat:write  (+ users:read.email
                                     si quieres @mención real al comercial)
        SLACK_CHANNEL_ID  C0BL7G1CMU6  (ya viene por defecto)
     B) Incoming Webhook apuntando al canal:
        SLACK_WEBHOOK_URL https://hooks.slack.com/services/...
   ========================================================================== */

const HS = 'https://api.hubapi.com';

// Canal de Slack por defecto: el que pidió el equipo (workspace ucademyespacio).
const DEFAULT_SLACK_CHANNEL = 'C0BL7G1CMU6';

function ok(res, body) { res.status(200).json({ ok: true, ...body }); }
function bad(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

async function hsGet(path, token) {
  const r = await fetch(HS + path, { headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text();
  let json = null;
  try { json = t ? JSON.parse(t) : null; } catch { /* no-JSON */ }
  return { ok: r.ok, status: r.status, json, text: t };
}
async function hsPost(path, token, body) {
  const r = await fetch(HS + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let json = null;
  try { json = t ? JSON.parse(t) : null; } catch { /* no-JSON */ }
  return { ok: r.ok, status: r.status, json, text: t };
}

/* Comercial del alumno = PROPIETARIO DE SU NEGOCIO (deal). Preferimos el negocio
   de acceso uni (si hay pipeline configurado) y, dentro de esos, el GANADO / más
   reciente. Fallbacks: cualquier negocio suyo → propietario del contacto.
   TODO solo lectura. Devuelve el ownerId o null. */
async function findReferrerDealOwner(token, email, pipelineId) {
  const search = await hsPost('/crm/v3/objects/contacts/search', token, {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'hubspot_owner_id'],
    limit: 1,
  });
  const contact = search.json?.results?.[0];
  if (!contact) return null;
  const contactOwner = contact.properties?.hubspot_owner_id || null;

  const assoc = await hsGet(`/crm/v4/objects/contacts/${contact.id}/associations/deals`, token);
  const dealIds = (assoc.json?.results || []).map((r) => r.toObjectId).filter(Boolean);
  if (!dealIds.length) return contactOwner;

  const batch = await hsPost('/crm/v3/objects/deals/batch/read', token, {
    properties: ['hubspot_owner_id', 'pipeline', 'hs_is_closed_won', 'closedate'],
    inputs: dealIds.map((id) => ({ id })),
  });
  const deals = (batch.json?.results || []).map((d) => d.properties || {});

  const uni = pipelineId
    ? deals.filter((d) => d.pipeline === pipelineId && d.hubspot_owner_id)
    : [];
  const pool = uni.length ? uni : deals.filter((d) => d.hubspot_owner_id);
  if (!pool.length) return contactOwner;

  pool.sort((a, b) => {
    const won = (b.hs_is_closed_won === 'true') - (a.hs_is_closed_won === 'true');
    if (won !== 0) return won;
    return String(b.closedate || '').localeCompare(String(a.closedate || ''));
  });
  return pool[0].hubspot_owner_id || contactOwner;
}

/* Nombre + email del propietario (para mostrarlo y para la @mención en Slack). */
async function ownerInfo(token, ownerId) {
  if (!ownerId) return { name: null, email: null };
  const r = await hsGet(`/crm/v3/owners/${ownerId}`, token);
  const o = r.json || {};
  const name = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || null;
  return { name, email: o.email || null };
}

/* Slack user id a partir del email (para @mencionar de verdad al comercial).
   Requiere el scope users:read.email en el bot. Si no está, devuelve null y
   nos quedamos con el nombre en texto. */
async function slackUserIdByEmail(botToken, email) {
  if (!botToken || !email) return null;
  const r = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const j = await r.json().catch(() => ({}));
  return j.ok ? j.user?.id : null;
}

function buildSlackText({ studentEmail, friend, course, notes, comercialLabel, hubspotOff, origin }) {
  const flag = origin === 'PT' ? '🇵🇹 Portugal' : '🇪🇸 España';
  return [
    `🗺️ *Nuevo referido — Plan Amigo Acceso Uni* · ${flag}${hubspotOff ? '  _(sin HubSpot: comercial no consultado)_' : ''}`,
    `*${studentEmail}* (comercial: ${comercialLabel}) ha referido a *${friend.name}*`,
    `*Colega:* ${friend.name} · ${friend.email} · ${friend.phone}`,
    `*Vía de acceso:* ${course}`,
    notes && notes !== '—' ? `*Comentario:* ${notes}` : null,
  ].filter(Boolean).join('\n');
}

/* Publica en Slack. Prioriza bot token (usa el ID del canal y permite @mención);
   si no, cae al Incoming Webhook. */
async function notifySlack(payload, comercial) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID || DEFAULT_SLACK_CHANNEL;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  // Etiqueta del comercial: @mención si podemos resolver su usuario de Slack.
  let comercialLabel = '— (sin comercial en HubSpot)';
  if (comercial?.name) {
    comercialLabel = `*${comercial.name}*`;
    if (botToken && comercial.email) {
      const uid = await slackUserIdByEmail(botToken, comercial.email).catch(() => null);
      if (uid) comercialLabel = `<@${uid}>`;
    }
  }

  const text = buildSlackText({ ...payload, comercialLabel });

  if (botToken) {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Slack chat.postMessage: ${j.error || r.status}`);
    return;
  }
  if (webhookUrl) {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return;
  }
  console.warn('[referido] Slack no configurado (ni SLACK_BOT_TOKEN ni SLACK_WEBHOOK_URL).');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  // Honeypot: bot detectado → fingimos éxito sin hacer nada.
  if (b.company && String(b.company).trim() !== '') return ok(res, { spam: true });

  const studentEmail = String(b.studentEmail || '').trim();
  const friendName = String(b.friendName || '').trim();
  const friendEmail = String(b.friendEmail || '').trim();
  const friendPhone = String(b.friendPhone || '').trim();
  const course = String(b.course || '—').trim() || '—';
  const notes = String(b.notes || '—').trim() || '—';
  const origin = String(b.origin || 'ES').trim().toUpperCase() === 'PT' ? 'PT' : 'ES';

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(studentEmail)) return bad(res, 422, 'studentEmail inválido');
  if (friendName.length < 2) return bad(res, 422, 'friendName inválido');
  if (!emailRe.test(friendEmail)) return bad(res, 422, 'friendEmail inválido');
  if (friendPhone.replace(/[\s.\-()]/g, '').replace(/^\+?34/, '').length < 9)
    return bad(res, 422, 'friendPhone inválido');

  const { HUBSPOT_TOKEN, HUBSPOT_ACCESO_UNI_PIPELINE_ID } = process.env;

  // 1) Comercial del alumno (solo lectura). Si algo falla, seguimos sin comercial:
  //    el aviso a Slack es lo prioritario, no lo bloqueamos por HubSpot.
  let comercial = { name: null, email: null };
  if (HUBSPOT_TOKEN) {
    try {
      const ownerId = await findReferrerDealOwner(HUBSPOT_TOKEN, studentEmail, HUBSPOT_ACCESO_UNI_PIPELINE_ID);
      comercial = await ownerInfo(HUBSPOT_TOKEN, ownerId);
    } catch (e) {
      console.error('[referido] HubSpot lookup error', e);
    }
  }

  // 2) Aviso a Slack
  try {
    await notifySlack(
      {
        studentEmail,
        friend: { name: friendName, email: friendEmail, phone: friendPhone },
        course, notes, origin, hubspotOff: !HUBSPOT_TOKEN,
      },
      comercial,
    );
  } catch (e) {
    console.error('[referido] Slack error', e);
    return bad(res, 502, 'No se pudo enviar el aviso a Slack.');
  }

  return ok(res, { comercial: comercial.name || null });
}
