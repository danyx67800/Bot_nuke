export const CHANNEL_TYPE = {
  TEXT: 0,
  VOICE: 2,
  CATEGORY: 4,
  ANNOUNCEMENT: 5,
  STAGE: 13,
  FORUM: 15,
  MEDIA: 16,
};

const LABELS = {
  0: 'Testuale',
  2: 'Vocale',
  4: 'Categoria',
  5: 'Annunci',
  13: 'Stage',
  15: 'Forum',
  16: 'Media',
};

/** Tipi su cui Discord permette di cambiare nome (le categorie restano fuori). */
const RENAMEABLE = new Set([0, 2, 5, 13, 15, 16]);

export function channelTypeLabel(type) {
  return LABELS[type] ?? `Tipo ${type}`;
}

export function isRenameableChannel(type) {
  return RENAMEABLE.has(Number(type));
}

/** I canali testuali vengono normalizzati da Discord: minuscole e spazi -> trattini. */
const TEXT_LIKE = new Set([0, 5, 15, 16]);

export function normalizeChannelName(raw, type = 0) {
  let name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (TEXT_LIKE.has(Number(type))) {
    name = name.toLowerCase().replace(/ /g, '-').replace(/-{2,}/g, '-');
  }
  return name.slice(0, 100);
}
