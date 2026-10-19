/* ==========================================================================
   /api/referido  —  Función serverless (Vercel, Node runtime)
   --------------------------------------------------------------------------
   Recibe una recomendación del "Plan Amigo" (Trae a un colega) de Atlas y:
     1. LEE en HubSpot el alumno que recomienda y saca el COMERCIAL = propietario
        de su CIERRE GANADO (deal closed-won) en Acceso Uni. (Solo lectura, con el
        token que ya está configurado — no crea ni modifica ninguna app.)
     2. CREA al colega como LEAD en HubSpot vía la API de FORMULARIOS (sin private
        app): medio = Referido, canal = Referido, referrer = alumno, y marca la
        propiedad "Plan Amigo Atlas".
     3. Avisa por Slack al canal, con @mención al comercial y los datos del colega.

   Variables de entorno (Vercel → Project → Settings → Environment Variables):
     HUBSPOT_PORTAL_ID   Portal de HubSpot. Por defecto 25603833 (el de Atlas).
     HUBSPOT_FORM_GUID   GUID del formulario de HubSpot "Plan Amigo – Referidos"
                         al que enviar el lead (API de Formularios, sin token).
                         Sin esto, NO se crea el lead (solo Slack).
     HUBSPOT_TOKEN       (solo lectura) Private App token YA existente, para saber
                         el comercial del cierre ganado. Scopes: contacts.read,
                         deals.read, owners.read. Si falta, el comercial no sale.
     HUBSPOT_ACCESO_UNI_PIPELINE_ID  IDs de pipeline Acceso Uni (coma-separados)
                         para priorizar el cierre ganado. Por defecto: Ventas,
                         Portugal y Selectividad.

   Slack — canal destino: ID C0BL7G1CMU6 (workspace ucademyespacio)
     SLACK_BOT_TOKEN   xoxb-...   scopes: chat:write (+ users:read.email para @mención)
     SLACK_CHANNEL_ID  C0BL7G1CMU6
     SLACK_WEBHOOK_URL https://hooks.slack.com/services/...  (alternativa al bot)
   ========================================================================== */

const HS = 'https://api.hubapi.com';
const DEFAULT_PORTAL_ID = '25603833';
const DEFAULT_SLACK_CHANNEL = 'C0BL7G1CMU6';

// Pipelines de Acceso Uni donde se cierra la matrícula (ganado).
//   2918144211 = Acceso Uni | Ventas   (cierre de matrícula)
//   2929367239 = Acceso Uni | Portugal
//   14929895   = Ucademy Selectividad
const DEFAULT_UNI_PIPELINES = ['2918144211', '2929367239', '14929895'];

function ok(res, body) { res.status(200).json({ ok: true, ...body }); }
function bad(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

async function hsGet(path, token) {
  const r = await fetch(HS + path, { headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text();
  let json = null; try { json = t ? JSON.parse(t) : null; } catch { /* no-JSON */ }
  return { ok: r.ok, status: r.status, json, text: t };
}
async function hsPost(path, token, body) {
  const r = await fetch(HS + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let json = null; try { json = t ? JSON.parse(t) : null; } catch { /* no-JSON */ }
  return { ok: r.ok, status: r.status, json, text: t };
}

/* ---- 1) COMERCIAL = propietario del CIERRE GANADO (solo lectura) ----------- */

async function findContactByEmail(token, email) {
  const r = await hsPost('/crm/v3/objects/contacts/search', token, {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'hubspot_owner_id'],
    limit: 1,
  });
  const c = r.json?.results?.[0];
  return { contact: c ? { id: c.id, ownerId: c.properties?.hubspot_owner_id || null } : null, status: r.status };
}

/* Prioridad: cierre GANADO en Acceso Uni > cierre ganado (otro pipeline) >
   deal abierto Acceso Uni > cualquier deal con dueño > dueño del contacto. */
async function findReferrerDealOwner(token, contactId, contactOwner, uniPipelines) {
  const diag = {};
  const assoc = await hsGet(`/crm/v4/objects/contacts/${contactId}/associations/deals`, token);
  diag.assocStatus = assoc.status;
  const dealIds = (assoc.json?.results || []).map((r) => r.toObjectId).filter(Boolean);
  diag.dealsFound = dealIds.length;
  if (!dealIds.length) return { ownerId: contactOwner, source: 'contact-owner (sin deals)', diag };

  const batch = await hsPost('/crm/v3/objects/deals/batch/read', token, {
    properties: ['hubspot_owner_id', 'pipeline', 'hs_is_closed_won', 'closedate', 'dealname'],
    inputs: dealIds.map((id) => ({ id })),
  });
  diag.batchStatus = batch.status;
  const deals = (batch.json?.results || []).map((d) => d.properties || {});

  const byRecent = (a, b) => String(b.closedate || '').localeCompare(String(a.closedate || ''));
  const isWon = (d) => d.hs_is_closed_won === 'true';
  const inUni = (d) => uniPipelines.includes(d.pipeline);
  const owned = (d) => !!d.hubspot_owner_id;
  const pick = (arr, source) => {
    const s = arr.filter(owned).sort(byRecent);
    return s.length ? { ownerId: s[0].hubspot_owner_id, source, deal: s[0].dealname } : null;
  };

  const result =
    pick(deals.filter((d) => isWon(d) && inUni(d)), 'cierre-ganado Acceso Uni') ||
    pick(deals.filter(isWon), 'cierre-ganado (otro pipeline)') ||
    pick(deals.filter(inUni), 'deal abierto Acceso Uni') ||
    pick(deals, 'deal con propietario');

  if (result) { diag.deal = result.deal; return { ownerId: result.ownerId, source: result.source, diag }; }
  return { ownerId: contactOwner, source: 'contact-owner (fallback)', diag };
}

async function ownerInfo(token, ownerId) {
  if (!ownerId) return { name: null, email: null, status: null };
  const r = await hsGet(`/crm/v3/owners/${ownerId}`, token);
  const o = r.json || {};
  const name = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || null;
  return { name, email: o.email || null, status: r.status };
}

/* ---- 2) CREAR LEAD vía API de Formularios (sin private app) ---------------- */

async function submitLeadViaForm(portalId, formGuid, friend, studentEmail, origin) {
  const parts = friend.name.trim().split(/\s+/);
  const firstname = parts.shift() || friend.name;
  const lastname = parts.join(' ');

  // Cada field.name debe existir como propiedad de CONTACTO Y estar en el form.
  // "referrer" no está habilitado en formularios, así que el email de quien
  // refiere se guarda dentro de "¿Cómo nos conociste?" (y además va a Slack).
  // El marcador "Atlas | Plan Amigo" vive en el NEGOCIO (deal): se pone en el
  // deal mediante un workflow de HubSpot a partir de medio=Referido.
  const fields = [
    { name: 'email', value: friend.email },
    { name: 'firstname', value: firstname },
    ...(lastname ? [{ name: 'lastname', value: lastname }] : []),
    { name: 'phone', value: friend.phone },
    { name: 'medio', value: 'Referido' },
    { name: 'canal', value: 'Referido' },
    { name: 'como_nos_conociste_', value: `Plan Amigo — referido por ${studentEmail}` },
  ];

  const url = `https://api-eu1.hsforms.com/submissions/v3/integration/submit/${portalId}/${formGuid}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields,
      context: { pageName: `Plan Amigo — Referido (${origin})`, pageUri: 'https://planamigo.atlasexam.pt/' },
    }),
  });
  const t = await r.text();
  let json = null; try { json = t ? JSON.parse(t) : null; } catch { /* no-JSON */ }
  return { ok: r.ok, status: r.status, error: r.ok ? null : (json?.message || json?.errors?.[0]?.message || t) };
}

/* ---- 3) Slack ------------------------------------------------------------- */

async function slackUserIdByEmail(botToken, email) {
  if (!botToken || !email) return null;
  const r = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const j = await r.json().catch(() => ({}));
  return j.ok ? j.user?.id : null;
}

function buildSlackText({ studentEmail, friend, course, notes, comercialLabel, origin, leadLine }) {
  const flag = origin === 'PT' ? '🇵🇹 Portugal' : '🇪🇸 España';
  return [
    `🗺️ *Nuevo referido — Plan Amigo Acceso Uni* · ${flag}`,
    `*${studentEmail}* (comercial: ${comercialLabel}) ha referido a *${friend.name}*`,
    `*Colega:* ${friend.name} · ${friend.email} · ${friend.phone}`,
    `*Vía de acceso:* ${course}`,
    notes && notes !== '—' ? `*Comentario:* ${notes}` : null,
    leadLine,
  ].filter(Boolean).join('\n');
}

async function notifySlack(payload, comercial) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID || DEFAULT_SLACK_CHANNEL;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return;
  }
  console.warn('[referido] Slack no configurado.');
}

/* ---- Handler -------------------------------------------------------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  if (b.company && String(b.company).trim() !== '') return ok(res, { spam: true }); // honeypot

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

  const {
    HUBSPOT_TOKEN, HUBSPOT_ACCESO_UNI_PIPELINE_ID,
    HUBSPOT_PORTAL_ID, HUBSPOT_FORM_GUID,
  } = process.env;

  const pipelines = (HUBSPOT_ACCESO_UNI_PIPELINE_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  const uniPipelines = pipelines.length ? pipelines : DEFAULT_UNI_PIPELINES;
  const portalId = HUBSPOT_PORTAL_ID || DEFAULT_PORTAL_ID;

  const friend = { name: friendName, email: friendEmail, phone: friendPhone };
  const diagnostics = { hubspotTokenPresent: !!HUBSPOT_TOKEN, formGuidPresent: !!HUBSPOT_FORM_GUID };
  let comercial = { name: null, email: null };

  // 1) Comercial del alumno (cierre ganado). Solo lectura, no bloquea nada.
  if (HUBSPOT_TOKEN) {
    try {
      const f = await findContactByEmail(HUBSPOT_TOKEN, studentEmail);
      diagnostics.studentFound = !!f.contact;
      if (f.contact) {
        const owner = await findReferrerDealOwner(HUBSPOT_TOKEN, f.contact.id, f.contact.ownerId, uniPipelines);
        diagnostics.ownerSource = owner.source;
        diagnostics.deals = owner.diag;
        comercial = await ownerInfo(HUBSPOT_TOKEN, owner.ownerId);
        diagnostics.comercial = comercial.name;
      }
    } catch (e) {
      console.error('[referido] HubSpot lookup error', e);
      diagnostics.lookupError = String(e);
    }
  }

  // 2) Crear el colega como lead referido (Forms API, sin private app).
  let lead = { ok: false };
  if (HUBSPOT_FORM_GUID) {
    try {
      lead = await submitLeadViaForm(portalId, HUBSPOT_FORM_GUID, friend, studentEmail, origin);
      diagnostics.lead = lead;
    } catch (e) {
      console.error('[referido] Forms API error', e);
      diagnostics.leadError = String(e);
    }
  }

  // Línea de estado del lead para Slack.
  let leadLine = null;
  if (HUBSPOT_FORM_GUID) {
    leadLine = lead.ok
      ? '✅ Lead creado en HubSpot como referido (medio: Referido)'
      : '⚠️ No se pudo crear el lead en HubSpot (revisar formulario/propiedades)';
  }

  // 3) Aviso a Slack (prioritario).
  try {
    await notifySlack({ studentEmail, friend, course, notes, origin, leadLine }, comercial);
  } catch (e) {
    console.error('[referido] Slack error', e);
    return bad(res, 502, 'No se pudo enviar el aviso a Slack.');
  }

  return ok(res, { comercial: comercial.name || null, leadCreated: !!lead.ok, diagnostics });
}
