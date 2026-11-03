const pad = (value) => String(value).padStart(2, '0');

/**
 * Template supportati in nomi canale e messaggi:
 *   {n}          numero del tick (parte da 1)
 *   {tick}       indice del tick (parte da 0)
 *   {time}       HH:MM
 *   {date}       GG/MM
 *   {rand:a|b}   una delle alternative scelte a caso
 */
export function renderText(template, ctx = {}) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  return String(template ?? '')
    .replace(/\{rand:([^}]+)\}/gi, (_match, options) => {
      const list = String(options).split('|').map((item) => item.trim()).filter(Boolean);
      if (!list.length) return '';
      return list[Math.floor(Math.random() * list.length)];
    })
    .replace(/\{n\}/gi, () => String(ctx.n ?? 1))
    .replace(/\{tick\}/gi, () => String(ctx.tick ?? 0))
    .replace(/\{time\}/gi, () => `${pad(now.getHours())}:${pad(now.getMinutes())}`)
    .replace(/\{date\}/gi, () => `${pad(now.getDate())}/${pad(now.getMonth() + 1)}`);
}
