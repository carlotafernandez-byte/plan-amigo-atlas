/* ==========================================================================
   /api/referido  —  Función serverless (Vercel, Node runtime)
   --------------------------------------------------------------------------
   Recibe una recomendación del "Plan Amigo" (Trae a un colega) de Atlas y:
     1. LEE en HubSpot el alumno que recomienda y saca el COMERCIAL = propietario
        de su CIERRE GANADO (deal closed-won) en Acceso Uni. Prioridad absoluta
        al cierre ganado; con fallbacks si aún no tiene uno.
     2. CREA (o actualiza) al colega como LEAD en HubSpot marcado como referido
        (referrer = alumno, canal = Plan Amigo). Si hay comercial y el colega es
        nuevo, se lo asigna al mismo comercial.
     3. Avisa por Slack al canal, con @mención al comercial y los datos del colega.

   Variables de entorno (Vercel → Project → Settings → Environment Variables):
     HUBSPOT_TOKEN                   Private App token. SCOPES NECESARIOS:
                                       crm.objects.contacts.read
                                       crm.objects.contacts.write   ← para crear el lead
                                       crm.objects.deals.read        ← para el cierre ganado
                                       crm.objects.owners.read       ← para el nombre del comercial
                                     (Si faltan owners.read/deals.read, el comercial
                                      NO aparece en Slack aunque el token exista.)
     HUBSPOT_ACCESO_UNI_PIPELINE_ID  IDs de pipeline de Acceso Uni (coma-separados)
                                     a los que dar prioridad para el cierre ganado.
                                     Por defecto: Ventas, Portugal y Selectividad.
     REFERRAL_ASSIGN_OWNER           "0" para NO asignar el lead referido al comercial
                                     (por defecto se asigna si el colega es nuevo).

   Slack — canal destino: ID C0BL7G1CMU6 (workspace ucademyespacio)
     SLACK_BOT_TOKEN   xoxb-...   scopes: chat:write (+ users:read.email para @mención)
     SLACK_CHANNEL_ID  C0BL7G1CMU6
     SLACK_WEBHOOK_URL https://hooks.slack.com/services/...  (alternativa al bot)
   ========================================================================== */

const HS = 'https://api.hubapi.com';

const DEFAULT_SLACK_CHANNEL = 'C0BL7G1CMU6';

// Pipelines de Acceso Uni donde se cierra la matrícula (ganado). Se usan para dar
// prioridad al comercial correcto. Se pueden sobreescribir con la env var.
//   2918144211 = Acceso Uni | Ventas   (cierre de matrícula)
//   2929367239 = Acceso Uni | Portugal
//   14929895   = Ucademy Selectividad
const DEFAULT_UNI_PIPELINES = ['2918144211', '2929367239', '14929895'];

function ok(res, body) { res.status(200).json({ ok: true, ...body }); }
function bad(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

async function hsGet(path, token) {
  const r = await fetch(HS + path, { headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text();
  let json = null;
  try { json = t ? JSON.parse(t) : null; } catch { /* no-JSON */ }
  return { ok: r.ok, status: r.status, json, text: t };
}
async function hsReq(method, path, token, body) {
  const r = await fetch(HS + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let json = null;
  try { json = t ? JSON.parse(t) : null; } catch { /* no-JSON */ }
  return { ok: r.ok, status: r.status, json, text: t };
}
const hsPost = (path, token, body) => hsReq('POST', path, token, body);
const hsPatch = (path, token, body) => hsReq('PATCH', path, token, body);

/* Busca el contacto del alumno por email. Devuelve { id, ownerId } o null. */
async function findContactByEmail(token, email) {
  const r = await hsPost('/crm/v3/objects/contacts/search', token, {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'hubspot_owner_id'],
    limit: 1,
  });
  const c = r.json?.results?.[0];
  if (!c) return { contact: null, status: r.status, ok: r.ok };
  return {
    contact: { id: c.id, ownerId: c.properties?.hubspot_owner_id || null },
    status: r.status, ok: r.ok,
  };
}

/* COMERCIAL = propietario del CIERRE GANADO del alumno.
   Prioridad:
     1) Deal GANADO en pipeline Acceso Uni (el más reciente).
     2) Cualquier deal GANADO (el más reciente).
     3) Deal abierto en pipeline Acceso Uni (el más reciente).
     4) Cualquier deal con propietario (el más reciente).
     5) Propietario del contacto.
   Todo solo lectura. Devuelve { ownerId, source, diag }. */
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
    const sorted = arr.filter(owned).sort(byRecent);
    return sorted.length ? { ownerId: sorted[0].hubspot_owner_id, source, deal: sorted[0].dealname } : null;
  };

  const result =
    pick(deals.filter((d) => isWon(d) && inUni(d)), 'cierre-ganado Acceso Uni') ||
    pick(deals.filter(isWon), 'cierre-ganado (otro pipeline)') ||
    pick(deals.filter(inUni), 'deal abierto Acceso Uni') ||
    pick(deals, 'deal con propietario');

  if (result) { diag.deal = result.deal; return { ownerId: result.ownerId, source: result.source, diag }; }
  return { ownerId: contactOwner, source: 'contact-owner (fallback)', diag };
}

/* Nombre + email del propietario (para mostrarlo y para la @mención en Slack). */
async function ownerInfo(token, ownerId) {
  if (!ownerId) return { name: null, email: null, status: null };
  const r = await hsGet(`/crm/v3/owners/${ownerId}`, token);
  const o = r.json || {};
  const name = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || null;
  return { name, email: o.email || null, status: r.status };
}

/* Crea (o actualiza) al colega como LEAD referido en HubSpot.
   Campos de texto seguros (referrer/canal/como_nos_conociste_). Si el colega es
   nuevo y hay comercial, se le asigna (hubspot_owner_id). Nunca reasigna un
   contacto que ya existía. Devuelve { created, id, status, error? }. */
async function upsertReferralLead(token, friend, studentEmail, ownerId, origin, assignOwner) {
  const parts = friend.name.trim().split(/\s+/);
  const firstname = parts.shift() || friend.name;
  const lastname = parts.join(' ');
  const canal = origin === 'PT' ? 'Plan Amigo (Acesso Uni PT)' : 'Plan Amigo (Acceso Uni)';

  // Propiedades comunes (seguras): si alguna no existiera, el retry las quita.
  const common = {
    firstname,
    ...(lastname ? { lastname } : {}),
    phone: friend.phone,
    referrer: studentEmail,
    canal,
    como_nos_conociste_: 'Me recomendó un amigo — Plan Amigo',
  };

  // ¿Existe ya el colega?
  const found = await findContactByEmail(token, friend.email);
  if (found.contact) {
    const r = await hsPatch(`/crm/v3/objects/contacts/${found.contact.id}`, token, { properties: common });
    if (r.ok) return { created: false, id: found.contact.id, status: r.status };
    // Retry sin props personalizadas por si alguna no existe en el portal.
    const r2 = await hsPatch(`/crm/v3/objects/contacts/${found.contact.id}`, token, {
      properties: { firstname, phone: friend.phone, referrer: studentEmail },
    });
    return { created: false, id: found.contact.id, status: r2.status, error: r2.ok ? null : (r.json?.message || r.text) };
  }

  // Nuevo contacto → lead referido.
  const createProps = {
    email: friend.email,
    ...common,
    lifecyclestage: 'lead',
    ...(assignOwner && ownerId ? { hubspot_owner_id: ownerId } : {}),
  };
  const r = await hsPost('/crm/v3/objects/contacts', token, { properties: createProps });
  if (r.ok) return { created: true, id: r.json?.id || null, status: r.status };

  // Retry mínimo (por si canal/como_nos_conociste_ no existieran, o el owner no fuese válido).
  const minimal = {
    email: friend.email, firstname, ...(lastname ? { lastname } : {}),
    phone: friend.phone, referrer: studentEmail, lifecyclestage: 'lead',
  };
  const r2 = await hsPost('/crm/v3/objects/contacts', token, { properties: minimal });
  if (r2.ok) return { created: true, id: r2.json?.id || null, status: r2.status, degraded: true };
  return { created: false, id: null, status: r2.status, error: r.json?.message || r.text };
}

/* Slack user id a partir del email (para @mencionar al comercial). */
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

  const { HUBSPOT_TOKEN, HUBSPOT_ACCESO_UNI_PIPELINE_ID, REFERRAL_ASSIGN_OWNER } = process.env;
  const uniPipelines = (HUBSPOT_ACCESO_UNI_PIPELINE_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const pipelines = uniPipelines.length ? uniPipelines : DEFAULT_UNI_PIPELINES;
  const assignOwner = REFERRAL_ASSIGN_OWNER !== '0';

  const friend = { name: friendName, email: friendEmail, phone: friendPhone };
  const diagnostics = { hubspotToken: !!HUBSPOT_TOKEN };
  let comercial = { name: null, email: null };
  let ownerId = null;
  let lead = { created: false };

  if (HUBSPOT_TOKEN) {
    try {
      // 1) Comercial del alumno = propietario del cierre ganado.
      const f = await findContactByEmail(HUBSPOT_TOKEN, studentEmail);
      diagnostics.contactSearchStatus = f.status;
      diagnostics.studentFound = !!f.contact;
      if (f.contact) {
        const owner = await findReferrerDealOwner(HUBSPOT_TOKEN, f.contact.id, f.contact.ownerId, pipelines);
        ownerId = owner.ownerId;
        diagnostics.ownerSource = owner.source;
        diagnostics.deals = owner.diag;
        comercial = await ownerInfo(HUBSPOT_TOKEN, ownerId);
        diagnostics.ownerFetchStatus = comercial.status;
        diagnostics.comercial = comercial.name;
      }
    } catch (e) {
      console.error('[referido] HubSpot lookup error', e);
      diagnostics.lookupError = String(e);
    }

    try {
      // 2) Crear el colega como lead referido.
      lead = await upsertReferralLead(HUBSPOT_TOKEN, friend, studentEmail, ownerId, origin, assignOwner);
      diagnostics.lead = lead;
    } catch (e) {
      console.error('[referido] HubSpot create lead error', e);
      diagnostics.leadError = String(e);
    }
  }

  // Línea de estado del lead para Slack.
  let leadLine = null;
  if (HUBSPOT_TOKEN) {
    if (lead.id && lead.created) leadLine = '✅ Lead creado en HubSpot como referido';
    else if (lead.id && !lead.created) leadLine = 'ℹ️ Colega ya existía en HubSpot (actualizado como referido)';
    else leadLine = '⚠️ No se pudo crear el lead en HubSpot (revisar scope contacts.write)';
  }

  // 3) Aviso a Slack (prioritario: si falla, devolvemos error).
  try {
    await notifySlack(
      { studentEmail, friend, course, notes, origin, leadLine },
      comercial,
    );
  } catch (e) {
    console.error('[referido] Slack error', e);
    return bad(res, 502, 'No se pudo enviar el aviso a Slack.');
  }

  return ok(res, {
    comercial: comercial.name || null,
    leadCreated: !!lead.id,
    diagnostics,
  });
}
