# Plan Amigo — Atlas × Ucademy (Acceso Uni)

Landing de referidos para **acceso a la universidad**, clon rebrandeado del
["Trae a un colega" de Explora FP](https://planamigo.explorafp.com/). Misma
mecánica, marca Atlas × Ucademy, y backend que escribe **solo** en la línea de
acceso uni de HubSpot — **sin tocar FP ni oposiciones**.

## Qué hace

Un alumno de Atlas recomienda a un colega. Si el colega se matricula, el alumno
cobra:

| Referido | Premio |
|---|---|
| 1.º | **100 €** |
| 2.º | **150 €** |
| 3.º y siguientes | **200 €** cada uno |

## Arquitectura

```
index.html            Landing estática (una sola página). POST a /api/referido.
api/referido.js        Función serverless (Vercel Node). Habla con HubSpot + Slack.
favicon.svg            Isotipo Atlas (Azul 03).
```

El front **nunca** ve el token de HubSpot ni el webhook de Slack: viven como
variables de entorno dentro de la función.

## Flujo del backend (`/api/referido`)

Solo lectura de HubSpot + aviso. **No escribe nada en HubSpot.**

1. **Lee** en HubSpot el negocio del alumno que recomienda (por su email) y saca
   su **propietario = el comercial asignado**.
2. Avisa por **Slack** al canal `C0BL7G1CMU6` (workspace *ucademyespacio*), con
   **@mención al comercial** e incluyendo los datos del colega (que vienen del
   formulario, no de HubSpot).

Formato del aviso:

```
🗺️ Nuevo referido — Plan Amigo Acceso Uni
alumno@email.com (comercial: @Nacho Grizzly) ha referido a Marta López
Colega: Marta López · marta@email.com · 600000000
Vía de acceso: Selectividad / PAU / EvAU
```

> El aviso a Slack es lo prioritario: si la consulta a HubSpot falla, el mensaje
> se manda igual, solo que sin el comercial.

### Avisos de Slack

Van al canal `C0BL7G1CMU6`. Dos formas de conectarlo (elige una):

- **Bot token (recomendado):** crea una app en
  [api.slack.com/apps](https://api.slack.com/apps), añade el scope `chat:write`,
  instálala en el workspace e **invita al bot al canal** (`/invite @tu-bot`).
  Pon el `xoxb-...` en `SLACK_BOT_TOKEN`. El canal ya está fijado por defecto en
  el código (`SLACK_CHANNEL_ID` lo sobreescribe si hiciera falta).
- **Incoming Webhook:** crea un webhook apuntando a ese canal y ponlo en
  `SLACK_WEBHOOK_URL` (deja vacío el bot token).

> Un enlace de canal de Slack no es una credencial: hay que generar el bot token
> o el webhook desde la administración del workspace.

### 🔒 Por qué no toca FP ni opos

- Usa la **misma key** de HubSpot que FP/opos (`HUBSPOT_TOKEN`), pero **de solo
  lectura**: no crea ni modifica nada.
- Para sacar el comercial, si defines `HUBSPOT_ACCESO_UNI_PIPELINE_ID`, prioriza
  el negocio del alumno **en ese pipeline** — así el comercial es el de acceso
  uni y nunca miramos FP ni oposiciones.

## Pendiente: tracking del referido para el pago (100/150/200)

Ahora mismo el endpoint **avisa al comercial** pero **no deja registro del colega
en HubSpot** (el token es de solo lectura). El comercial recoge el aviso de Slack
y sigue el proceso.

Si más adelante quieres que el pago se calcule solo, hace falta **escribir** el
referido en HubSpot (crear el contacto del colega + un deal en el pipeline de
acceso uni con `referido_por_email`), y disparar el premio con un workflow cuando
ese deal pase a **ganado**. Eso requiere un token con scopes de escritura
(`crm.objects.contacts.write`, `crm.objects.deals.write`). Se puede añadir sin
tocar el resto.

Al filtrar por pipeline = Acceso Uni, los ganados de FP y opos quedan fuera.

## Puesta en marcha

1. Rellena las variables (ver [`.env.example`](.env.example)):
   ```bash
   cp .env.example .env.local
   ```
2. Crea (una vez) las propiedades de deal en HubSpot: `referido_por_email`
   (texto) y `referido_via_acceso` (texto). *Si no existen, la función reintenta
   creando el deal sin ellas — el referido no se pierde, pero pierdes trazabilidad.*
3. Local:
   ```bash
   npm i -g vercel
   vercel dev
   ```
4. Deploy:
   ```bash
   vercel deploy --prod
   ```

> **Modo demo:** sin `HUBSPOT_TOKEN`, el formulario funciona igual (muestra el
> "¡enviado!") y, si hay Slack configurado, avisa al canal marcándolo como
> demo. No se escribe nada en HubSpot. Útil para ver la landing recién desplegada.

## Pendiente de confirmar

- **URL de política de privacidad** en el footer de `index.html` (ahora apunta a
  `ucademy.com/politica-de-privacidad` — cámbiala si la vuestra es otra).
- **Dominio**: la original vive en `planamigo.explorafp.com`. El equivalente
  natural sería algo tipo `planamigo.atlas...` — configúralo en Vercel → Domains.
