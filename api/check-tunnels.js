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

// El servidor (Vercel) trabaja en hora UTC, pero las horas de los lotes se escriben en hora de Chile.
// Por eso todo se calcula con la hora de Santiago, no con la hora del servidor.
const TZ_CHILE = 'America/Santiago';
function partesChile(date) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: TZ_CHILE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(date).forEach((x) => { if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10); });
  return p;
}
function offsetChileMin(date) {
  const p = partesChile(date);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}
// Instante real que corresponde a una hora "de reloj" en Chile (año, mes, día, hora, minuto)
function fechaChile(y, mo, d, h, mi) {
  const aprox = Date.UTC(y, mo - 1, d, h, mi);
  let t = aprox - offsetChileMin(new Date(aprox)) * 60000;
  t = aprox - offsetChileMin(new Date(t)) * 60000; // reajuste por cambio de horario
  return new Date(t);
}

// Igual que resolveInicioDate en la app: ancla la hora de inicio en el día real de hoy (en Chile), y si
// queda más de 2h en el futuro, asume que en realidad fue ayer (turno de la noche anterior).
function resolveInicioDate(horaInicio, now) {
  if (!horaInicio) return null;
  const [h, m] = horaInicio.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const hoy = partesChile(now);
  let d = fechaChile(hoy.year, hoy.month, hoy.day, h, m);
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

// --- Contador de consumo de Firebase del propio servidor ---
// Cuenta lo que lee/escribe este servidor y lo suma (cada ~10 minutos) al documento del día,
// para que el panel "Consumo de Firebase" de la app muestre también esto.
const uso = { sr: 0, sw: 0, sd: 0, sdn: 0 };
let ultimoVolcado = 0;
let cacheTemporada = { valor: null, en: 0 };
function diaPacifico() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
async function volcarUso(db, fb) {
  if (Date.now() - ultimoVolcado < 10 * 60 * 1000) return;
  if (!(uso.sr || uso.sw || uso.sd || uso.sdn)) return;
  const inc = fb.firestore.FieldValue.increment;
  const dia = diaPacifico();
  const copia = { ...uso };
  const batch = db.batch();
  batch.set(db.collection('kv').doc(encodeURIComponent('uso-prefrios:' + dia)), { sr: inc(copia.sr), sw: inc(copia.sw + 2), sd: inc(copia.sd), dia }, { merge: true });
  batch.set(db.collection('kv').doc(encodeURIComponent('uso-prefrios:m-' + dia.slice(0, 7))), { sdn: inc(copia.sdn), mes: dia.slice(0, 7) }, { merge: true });
  await batch.commit();
  uso.sr -= copia.sr; uso.sw -= copia.sw; uso.sd -= copia.sd; uso.sdn -= copia.sdn;
  ultimoVolcado = Date.now();
}

async function volcarSeguro(db, fb) { try { await volcarUso(db, fb); } catch (e) { console.error('uso', e && e.message); } }

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
    //    (se recuerda 10 minutos para no leerla en cada revisión: ahorra lecturas del plan gratis)
    let temporada;
    if (cacheTemporada.valor && Date.now() - cacheTemporada.en < 10 * 60 * 1000) {
      temporada = cacheTemporada.valor;
    } else {
      const temporadaSnap = await db.collection('kv').doc(encodeURIComponent('prefrios:temporada-actual')).get();
      uso.sr += 1;
      temporada = temporadaSnap.exists ? temporadaSnap.data().value : '2026-27';
      cacheTemporada = { valor: temporada, en: Date.now() };
    }

    // 2) Datos de los túneles de esa temporada
    const tunnelsKey = `prefrios:tunnels-global:${temporada}`;
    const tunnelsSnap = await db.collection('kv').doc(encodeURIComponent(tunnelsKey)).get();
    uso.sr += 1;
    if (tunnelsSnap.exists) { try { uso.sdn += String(tunnelsSnap.data().value || '').length; } catch (e) {} }
    if (!tunnelsSnap.exists) {
      await volcarSeguro(db, fb); res.status(200).json({ ok: true, checked: 0, notified: 0, note: 'sin datos de túneles todavía' });
      return;
    }
    let parsed;
    try { parsed = JSON.parse(tunnelsSnap.data().value); } catch (e) {
      await volcarSeguro(db, fb); res.status(200).json({ ok: true, checked: 0, notified: 0, note: 'datos de túneles no legibles' });
      return;
    }
    const tunnels = (parsed && parsed.tunnels) || {};
    const now = new Date();

    // 3) Para cada lote activo, calcular si está en ámbar/rojo y si cambió desde la última
    //    revisión (para avisar solo una vez por evento, igual que en la app).
    const toNotify = [];
    const stateUpdates = [];
    const activeKeys = new Set();   // anotaciones que corresponden a lotes activos ahora
    let checked = 0;

    // Una sola lectura de todas las anotaciones (antes era una lectura por lote activo, cada minuto).
    const estadoSnap = await db.collection('push-state').get();
    uso.sr += Math.max(1, estadoSnap.docs.length);
    const estadoPorId = new Map(estadoSnap.docs.map((d) => [d.id, d.data()]));

    for (let i = 1; i <= TUNNEL_COUNT; i++) {
      const lotes = (tunnels[i] && tunnels[i].lotes) || [];
      for (let li = 0; li < lotes.length; li++) {
        const lote = lotes[li];
        const st = loteStatus(lote, now);
        if (!st) continue;
        checked++;
        const stateKey = `${temporada}-${i}-${li}-${st.nextEvent}`;
        activeKeys.add(stateKey);
        // "firma" del ciclo: si el lote es otro proceso (otra hora/fecha de inicio o duración),
        // la anotación vieja no vale y se vuelve a avisar desde cero.
        const sig = `${lote.fechaProceso || ''}|${lote.horaInicio}|${lote.duracionTotal || ''}`;
        const stateRef = db.collection('push-state').doc(stateKey);
        const stored = estadoPorId.has(stateKey) ? estadoPorId.get(stateKey) : null;
        const mismoCiclo = !!stored && (!stored.sig || stored.sig === sig);
        const lastNivel = mismoCiclo ? stored.nivel : null;
        if (st.nivel && st.nivel !== lastNivel) {
          toNotify.push({ tunnel: i, loteIndex: li, ...st });
          stateUpdates.push(() => stateRef.set({ nivel: st.nivel, sig, updatedAt: fb.firestore.FieldValue.serverTimestamp() }));
        } else if (!st.nivel && stored) {
          // Volvió a la normalidad (se registró la inversión/término a tiempo): limpia el estado.
          stateUpdates.push(() => stateRef.delete());
        } else if (stored && !stored.sig) {
          // Anotación antigua sin firma: se le agrega, sin avisar de nuevo.
          stateUpdates.push(() => stateRef.set({ nivel: stored.nivel, sig }, { merge: true }));
        }
      }
    }

    // 4) Mandar los avisos a todos los celulares/PCs suscritos.
    let notified = 0;
    if (toNotify.length) {
      const subsSnap = await db.collection('push-subscriptions').get();
      uso.sr += Math.max(1, subsSnap.docs.length);
      // enabled === false -> esa persona silenció los avisos en su celular (p.ej. al salir
      // del turno); se respeta y no se le manda nada hasta que lo reactive.
      const subs = subsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.enabled !== false);
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
          // --- APK de Android: aviso por Firebase Cloud Messaging ---
          if (sub.type === 'fcm') {
            try {
              await fb.messaging().send({
                token: sub.token,
                notification: { title, body },
                data: { nivel: String(item.nivel), tag: `tunel-${item.tunnel}-${item.nextEvent}` },
                android: {
                  priority: 'high',
                  notification: {
                    channelId: 'avisos',
                    tag: `tunel-${item.tunnel}-${item.nextEvent}`,
                    sound: 'default',
                    defaultVibrateTimings: true,
                    priority: 'max',
                    icon: 'ic_stat_prefrios',
                    color: '#0E7C86',
                  },
                },
              });
              notified++;
            } catch (err) {
              const c = err && err.code;
              if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') {
                // El celular ya no existe (se desinstaló la app, etc.): se borra.
                await db.collection('push-subscriptions').doc(sub.id).delete().catch(() => {});
              } else {
                console.error('FCM error', c, err && err.message);
              }
            }
            continue;
          }
          // --- Navegador / PWA: Web Push ---
          if (!sub.endpoint) continue;
          try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
            notified++;
          } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
              // La suscripción ya no existe (se desinstaló la app, etc.): se borra.
              await db.collection('push-subscriptions').doc(sub.id).delete().catch(() => {});
            }
          }
        }
      }
    }

    await Promise.all(stateUpdates.map((fn) => fn()));
    uso.sw += stateUpdates.length;

    // 5) Limpieza: borra anotaciones de lotes que ya no están activos (terminaron, se vaciaron
    //    o cambió el evento esperado). Sin esto quedaban pegadas y tapaban avisos del ciclo siguiente.
    let limpiadas = 0;
    try {
      const borrar = estadoSnap.docs.filter((d) => d.id.startsWith(`${temporada}-`) && !activeKeys.has(d.id));
      await Promise.all(borrar.map((d) => d.ref ? d.ref.delete() : db.collection('push-state').doc(d.id).delete()));
      limpiadas = borrar.length;
      uso.sd += borrar.length;
    } catch (e) { console.error('limpieza push-state', e && e.message); }

    await volcarSeguro(db, fb); res.status(200).json({ ok: true, checked, avisos: toNotify.length, notificacionesEnviadas: notified, anotacionesLimpiadas: limpiadas });
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
