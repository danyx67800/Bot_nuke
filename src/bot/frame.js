import { renderText } from './render.js';

function variantsOf(namesConfig, channelId) {
  const list = namesConfig?.[channelId];
  if (!Array.isArray(list)) return [];
  return list.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function textsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item ?? '').trim()).filter(Boolean);
}

/**
 * Stato desiderato per un dato tick: nomi da applicare, rotazione dell'ordine
 * e testo del messaggio. Funzione pura: la stessa usata dal motore, dalla
 * dashboard e dall'endpoint di anteprima.
 */
export function computeFrame(cfg, tick = 0, now = new Date()) {
  const index = Math.max(0, Math.floor(Number(tick) || 0));
  const animated = Array.isArray(cfg?.channels?.animated) ? cfg.channels.animated : [];
  const namesConfig = cfg?.rotation?.names ?? {};
  const ctx = {
    n: index + 1,
    tick: index,
    now,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  };

  const names = animated.map((channel) => {
    const list = variantsOf(namesConfig, channel.id);
    const template = list.length ? list[index % list.length] : '';
    return {
      id: channel.id,
      channelName: channel.name,
      template,
      name: renderText(template, ctx),
    };
  });

  const total = animated.length;
  const shifts = Array.isArray(cfg?.rotation?.shifts) ? cfg.rotation.shifts : [];
  let shift = 0;
  if (total > 1 && shifts.length) {
    const raw = Math.trunc(Number(shifts[index % shifts.length]) || 0);
    shift = ((raw % total) + total) % total;
  }

  const texts = textsOf(cfg?.messages?.texts);
  const text = texts.length ? renderText(texts[index % texts.length], ctx) : '';

  return { index, names, shift, text, texts };
}
