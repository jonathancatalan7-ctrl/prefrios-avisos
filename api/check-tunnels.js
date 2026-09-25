// Revisa los 16 túneles guardados en Firestore y manda una notificación push (con
// vibración) cuando alguno entra en zona "ámbar" (5 minutos o menos para su inversión o
// término) o "rojo" (ya se pasó la hora) — las mismas reglas que usa la app en pantalla.
//
// Pensado para ser llamado cada 1 minuto por un servicio externo gratuito (cron-job.org),
// ya que el plan gratis de Vercel no permite cron tan seguido. Protegido con un secreto
// (CRON_SECRET) para que nadie más pueda dispararlo.
//
// Variables de entorno necesarias (se configuran en el panel de Vercel, nunca en el código):
//   FIREBASE_SERVICE_ACCOUNT_JSON  -> el JSON completo de la cuenta de servicio de Firebase
//   PUSH_VAPID_PUBLIC_KEY          -> la misma llave pública que usa la app
//   PUSH_VAPID_PRIVATE_KEY         -> la llave privada pareja (nunca va en la app)
//   CRON_SECRET                    -> una palabra secreta inventada, para proteger este endpoint

const admin = require('firebase-admin');
const webpush = require('web-push');

const TUNNEL_COUNT = 16;

// Misma tabla que en la app (RegistroPrefrios.jsx): horas hasta inversión / horas desde
// inversión hasta término, según la duración total elegida para el lote.
const TIEMPOS_TUNEL = {
  7: { inversion: 4.5, termino: 2.5 },
  8: { inversion: 5.0, termino: 3.0 },
  9: { inversion: 6.0, termino: 3.0 },
  10: { inversion: 6.5, termino: 3.5 },
  11: { inversion: 7.0, termino: 4.0 },
  13: { inversion: 8.5, termino: 4.5 },
  16: { inversion: 10.5, termino: 5.5 },
};

function addHoursToDate(d, hours) {
  if (!d || hours === undefined || hours === null || isNaN(hours)) return null;
  return new Date(d.getTime() + Math.round(hours * 60) * 60000);
}

// Igual que resolveInicioDate en la app: ancla la hora de inicio en el día real de hoy, y si
// queda más de 2h en el futuro, asume que en realidad fue ayer (turno de la noche anterior).
function resolveInicioDate(horaInicio, now) {
  if (!horaInicio) return null;
  const [h, m] = horaInicio.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (d.getTime() - now.getTime() > 2 * 60 * 60 * 1000) {
    d = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  }
  return d;
}

function loteStatus(lote, now) {
  if (!lote.horaInicio || lote.horaTerminoReal) return null;
  const tiempos = TIEMPOS_TUNEL[lote.duracionTotal] || { inversion: 0, termino: 0 };
  const inicioDate = resolveInicioDate(lote.horaInicio, now);
  if (!inicioDate) return null;
  const inversionDate = addHoursToDate(inicioDate, tiempos.inversion);
  const terminoDate = addHoursToDate(inversionDate, tiempos.termino);
  const isInverted = !!lote.horaInversionReal;
  const nextEvent = isInverted ? 'termino' : 'inversion';
  const eventDate = isInverted ? terminoDate : inversionDate;
  if (!eventDate) return null;
  const diffMinutes = (eventDate.getTime() - now.getTime()) / 60000;
  let nivel = null;
  if (diffMinutes <= 0) nivel = 'rojo';
  else if (diffMinutes <= 5) nivel = 'ambar';
  return { nextEvent, diffMinutes, nivel };
}

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT_JSON');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}

module.exports = async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  try {
    const fb = getFirebaseAdmin();
    const db = fb.firestore();

    webpush.setVapidDetails(
      'mailto:avisos@santaelena-prefrios.local',
      process.env.PUSH_VAPID_PUBLIC_KEY,
      process.env.PUSH_VAPID_PRIVATE_KEY
    );

    // 1) Temporada actual
    const temporadaSnap = await db.collection('kv').doc(encodeURIComponent('prefrios:temporada-actual')).get();
    const temporada = temporadaSnap.exists ? temporadaSnap.data().value : '2026-27';

    // 2) Datos de los túneles de esa temporada
    const tunnelsKey = `prefrios:tunnels-global:${temporada}`;
    const tunnelsSnap = await db.collection('kv').doc(encodeURIComponent(tunnelsKey)).get();
    if (!tunnelsSnap.exists) {
      res.status(200).json({ ok: true, checked: 0, notified: 0, note: 'sin datos de túneles todavía' });
      return;
    }
    let parsed;
    try { parsed = JSON.parse(tunnelsSnap.data().value); } catch (e) {
      res.status(200).json({ ok: true, checked: 0, notified: 0, note: 'datos de túneles no legibles' });
      return;
    }
    const tunnels = (parsed && parsed.tunnels) || {};
    const now = new Date();

    // 3) Para cada lote activo, calcular si está en ámbar/rojo y si cambió desde la última
    //    revisión (para avisar solo una vez por evento, igual que en la app).
    const toNotify = [];
    const stateUpdates = [];
    let checked = 0;

    for (let i = 1; i <= TUNNEL_COUNT; i++) {
      const lotes = (tunnels[i] && tunnels[i].lotes) || [];
      for (let li = 0; li < lotes.length; li++) {
        const lote = lotes[li];
        const st = loteStatus(lote, now);
        if (!st) continue;
        checked++;
        const stateKey = `${temporada}-${i}-${li}-${st.nextEvent}`;
        const stateRef = db.collection('push-state').doc(stateKey);
        const stateSnap = await stateRef.get();
        const lastNivel = stateSnap.exists ? stateSnap.data().nivel : null;
        if (st.nivel && st.nivel !== lastNivel) {
          toNotify.push({ tunnel: i, loteIndex: li, ...st });
          stateUpdates.push(() => stateRef.set({ nivel: st.nivel, updatedAt: fb.firestore.FieldValue.serverTimestamp() }));
        } else if (!st.nivel && lastNivel) {
          // Volvió a la normalidad (se registró la inversión/término a tiempo): limpia el estado.
          stateUpdates.push(() => stateRef.delete());
        }
      }
    }

    // 4) Mandar los avisos a todos los celulares/PCs suscritos.
    let notified = 0;
    if (toNotify.length) {
      const subsSnap = await db.collection('push-subscriptions').get();
      // enabled === false -> esa persona silenció los avisos en su celular (p.ej. al salir
      // del turno); se respeta y no se le manda nada hasta que lo reactive.
      const subs = subsSnap.docs.map((d) => d.data()).filter((s) => s.enabled !== false);
      for (const item of toNotify) {
        const loteLabel = lotesMultiplesLabel(tunnels[item.tunnel], item.loteIndex);
        const title = item.nivel === 'rojo'
          ? `⚠️ Túnel ${item.tunnel}${loteLabel} atrasado`
          : `Túnel ${item.tunnel}${loteLabel}`;
        const body = item.nivel === 'rojo'
          ? (item.nextEvent === 'inversion' ? 'Ya pasó la hora de inversión' : 'Ya pasó la hora de término')
          : (item.nextEvent === 'inversion' ? 'Inversión en menos de 5 minutos' : 'Término en menos de 5 minutos');
        const payload = JSON.stringify({ title, body, nivel: item.nivel, tag: `tunel-${item.tunnel}-${item.nextEvent}` });
        for (const sub of subs) {
          try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
            notified++;
          } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
              // La suscripción ya no existe (se desinstaló la app, etc.): se borra.
              await db.collection('push-subscriptions').doc(encodeURIComponent(sub.endpoint)).delete().catch(() => {});
            }
          }
        }
      }
    }

    await Promise.all(stateUpdates.map((fn) => fn()));

    res.status(200).json({ ok: true, checked, avisos: toNotify.length, notificacionesEnviadas: notified });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

function lotesMultiplesLabel(tunnel, loteIndex) {
  const lotes = (tunnel && tunnel.lotes) || [];
  if (lotes.length <= 1) return '';
  return ` Lote ${String.fromCharCode(65 + loteIndex)}`;
}
