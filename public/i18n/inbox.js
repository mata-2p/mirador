// Attention inbox (public/features/inbox.js).

/** The night service's deferral rules (src/night/service.ts, policy.ts) that read as a short phrase. */
const NIGHT_RULES = {
  'low-confidence': 'inbox.night.rule.lowConfidence',
  decider: 'inbox.night.rule.decider',
  'auto-cap': 'inbox.night.rule.autoCap',
  'no-final-message': 'inbox.night.rule.noFinalMessage',
  stale: 'inbox.night.rule.stale',
  busy: 'inbox.night.rule.busy',
  'not-connected': 'inbox.night.rule.notConnected',
  'not-delivered': 'inbox.night.rule.notDelivered',
  timeout: 'inbox.night.rule.timeout',
  stopped: 'inbox.night.rule.stopped',
  error: 'inbox.night.rule.error',
  'invalid-decision': 'inbox.night.rule.invalid',
};

/** The i18n key (and its values) for a deferral rule; `sensitive:<topic>` names the topic; anything else falls back. */
export function nightRuleKey(rule) {
  if (typeof rule === 'string' && rule.startsWith('sensitive:')) return { key: 'inbox.night.rule.sensitive', vars: { topic: rule.slice('sensitive:'.length) } };
  return { key: (typeof rule === 'string' && Object.hasOwn(NIGHT_RULES, rule) && NIGHT_RULES[rule]) || 'inbox.night.rule.other' };
}

const RESOLVED = { question: 'inbox.night.chose', 'follow-up': 'inbox.night.continued', note: 'inbox.night.delivered' };
/** The badge's sprite icon (public/icons.js): working while it decides, done, or waiting for you. */
const NIGHT_ICONS = { deciding: 'work', resolved: 'check', deferred: 'wait' };

/**
 * How a card words its night state (`item.night`), DOM-free: `{ state, icon, badge, line, title }`,
 * or null without one. `t` is the translate function. The inbox and the tracking view share it.
 */
export function nightView(night, t) {
  if (!night || !['deciding', 'resolved', 'deferred'].includes(night.state)) return null;
  const badge = t(`inbox.night.badge.${night.state}`);
  const icon = NIGHT_ICONS[night.state];
  if (night.state === 'deciding') return { state: night.state, icon, badge, line: t('inbox.night.deciding'), title: '' };
  if (night.state === 'resolved') return { state: night.state, icon, badge, line: t(RESOLVED[night.flow] ?? RESOLVED['follow-up'], { summary: night.summary ?? '' }), title: night.summary ?? '' };
  const { key, vars } = nightRuleKey(night.rule);
  return { state: night.state, icon, badge, line: t('inbox.night.deferred', { reason: t(key, vars) }), title: night.reason ?? '' };
}

export default {
  en: {
    'inbox.label': 'Terminals waiting for you',
    'inbox.answer': 'Needs you',
    'inbox.answerOrder': 'Longest wait first',
    'inbox.review': 'Finished, ready for review',
    'inbox.root': '(root)',
    'inbox.empty': 'No agent is waiting for you now.',
    'inbox.reason.guarded': 'Wants to run a guarded command',
    'inbox.reason.questionnaire': 'Has questions for you',
    'inbox.reason.choice': 'Needs you to choose',
    'inbox.reason.input': 'Waiting for your answer',
    'inbox.reason.finished': 'Finished its turn',
    'inbox.reason.question': 'Asked you a question',
    'inbox.reason.note': 'Got your execution note',
    'inbox.reason.error': 'Stopped with an error',
    'inbox.waited.now': 'just now',
    'inbox.waited.minutes': '{count} min',
    'inbox.waited.hours': '{count} h',
    'inbox.since': 'Waiting since {time}',
    'inbox.jump': 'Go to this terminal',
    'inbox.elsewhere': 'open in another {brand} window',
    'inbox.openFile': 'Open {file}',
    'inbox.notify.label': 'Browser notifications',
    'inbox.notify.turnOn': 'Turn on browser notifications',
    'inbox.notify.turnOff': 'Turn off browser notifications',
    'inbox.notify.asking': 'Waiting for the browser to answer…',
    'inbox.notify.status.on': 'On: one notice when an agent starts waiting for you or stops with an error.',
    'inbox.notify.status.off': 'Off. The browser asks for permission when you turn them on.',
    'inbox.notify.status.denied': 'Blocked by the browser. Allow notifications for this site in the browser settings to use them.',
    'inbox.notify.status.unsupported': 'Browser notifications are not available here.',
    'inbox.notify.options': 'Notification options',
    'inbox.notify.stay': 'Notices that need an answer stay until you act',
    'inbox.notify.discreet': 'Discreet: no project or question, for screen sharing',
    // The discreet title, and a burst's (public/features/inbox-notify-model.js).
    'inbox.notify.waiting.one': 'An agent is waiting for you',
    'inbox.notify.waiting.other': '{count} agents are waiting for you',
    'inbox.night.badge.deciding': 'Deciding',
    'inbox.night.badge.resolved': '{brand} moved on',
    'inbox.night.badge.deferred': 'Left for you',
    'inbox.night.deciding': '{brand} is deciding…',
    'inbox.night.chose': '{brand} chose “{summary}”',
    'inbox.night.continued': '{brand} continued: {summary}',
    'inbox.night.delivered': '{brand} delivered your note: {summary}',
    'inbox.night.deferred': '{brand} left it for you: {reason}',
    'inbox.night.rule.sensitive': 'it touches something sensitive ({topic})',
    'inbox.night.rule.lowConfidence': 'it was not sure enough',
    'inbox.night.rule.decider': 'it preferred to wait for you',
    'inbox.night.rule.autoCap': 'enough automatic follow-ups tonight',
    'inbox.night.rule.noFinalMessage': 'it does not know how the turn ended',
    'inbox.night.rule.stale': 'the agent moved on first',
    'inbox.night.rule.busy': 'it was busy with this terminal',
    'inbox.night.rule.notConnected': 'it cannot reach this agent',
    'inbox.night.rule.notDelivered': 'the agent did not confirm the message',
    'inbox.night.rule.timeout': 'it took too long to decide',
    'inbox.night.rule.stopped': 'the night shift was turned off',
    'inbox.night.rule.error': 'the decider failed',
    'inbox.night.rule.invalid': 'its answer did not fit',
    'inbox.night.rule.other': 'it needs your review',
    // The phone layout (public/features/phone.js).
    'inbox.phone.title': 'Waiting for you ({count})',
    'inbox.phone.live': 'Live',
    'inbox.phone.reconnecting': 'Reconnecting…',
    'inbox.phone.signedOut': 'Signed out',
    'inbox.phone.toDeck': 'Terminals',
    'inbox.phone.toDeckLabel': 'Back to the terminals',
    'inbox.phone.full': 'Open the full interface',
    'inbox.phone.fullHint': 'Workspaces, files, autopilot and settings.',
    'inbox.phone.toInbox': 'Waiting for you',
    'inbox.phone.toInboxLabel': 'Back to the agents waiting for you',
  },
  es: {
    'inbox.label': 'Terminales que te esperan',
    'inbox.answer': 'Te necesitan',
    'inbox.answerOrder': 'La espera más larga primero',
    'inbox.review': 'Terminaron, listas para revisar',
    'inbox.root': '(raíz)',
    'inbox.empty': 'Ningún agente te espera ahora.',
    'inbox.reason.guarded': 'Quiere ejecutar un comando protegido',
    'inbox.reason.questionnaire': 'Tiene preguntas para ti',
    'inbox.reason.choice': 'Necesita que elijas',
    'inbox.reason.input': 'Espera tu respuesta',
    'inbox.reason.finished': 'Terminó su turno',
    'inbox.reason.question': 'Te hizo una pregunta',
    'inbox.reason.note': 'Recibió tu nota de ejecución',
    'inbox.reason.error': 'Se detuvo con un error',
    'inbox.waited.now': 'recién',
    'inbox.waited.minutes': '{count} min',
    'inbox.waited.hours': '{count} h',
    'inbox.since': 'Esperando desde las {time}',
    'inbox.jump': 'Ir a esta terminal',
    'inbox.elsewhere': 'abierta en otra ventana de {brand}',
    'inbox.openFile': 'Abrir {file}',
    'inbox.notify.label': 'Avisos del navegador',
    'inbox.notify.turnOn': 'Activar avisos del navegador',
    'inbox.notify.turnOff': 'Desactivar avisos del navegador',
    'inbox.notify.asking': 'Esperando la respuesta del navegador…',
    'inbox.notify.status.on': 'Activados: un aviso cuando un agente empieza a esperarte o se detiene con un error.',
    'inbox.notify.status.off': 'Desactivados. El navegador pide permiso cuando los activas.',
    'inbox.notify.status.denied': 'Bloqueados por el navegador. Permite las notificaciones de este sitio en la configuración del navegador para usarlos.',
    'inbox.notify.status.unsupported': 'Avisos del navegador no disponibles aquí.',
    'inbox.notify.options': 'Opciones de los avisos',
    'inbox.notify.stay': 'Los avisos que piden respuesta se quedan hasta que actúes',
    'inbox.notify.discreet': 'Discretos: sin proyecto ni pregunta, para compartir pantalla',
    // El título discreto, y el de una ráfaga (public/features/inbox-notify-model.js).
    'inbox.notify.waiting.one': 'Un agente te espera',
    'inbox.notify.waiting.other': '{count} agentes te esperan',
    'inbox.night.badge.deciding': 'Decidiendo',
    'inbox.night.badge.resolved': '{brand} avanzó',
    'inbox.night.badge.deferred': 'Pendiente para ti',
    'inbox.night.deciding': '{brand} está decidiendo…',
    'inbox.night.chose': '{brand} eligió «{summary}»',
    'inbox.night.continued': '{brand} continuó: {summary}',
    'inbox.night.delivered': '{brand} entregó tu nota: {summary}',
    'inbox.night.deferred': '{brand} lo dejó pendiente: {reason}',
    'inbox.night.rule.sensitive': 'toca algo sensible ({topic})',
    'inbox.night.rule.lowConfidence': 'no estaba lo bastante seguro',
    'inbox.night.rule.decider': 'prefirió esperarte',
    'inbox.night.rule.autoCap': 'ya hizo bastantes seguimientos esta noche',
    'inbox.night.rule.noFinalMessage': 'no sabe cómo terminó el turno',
    'inbox.night.rule.stale': 'el agente avanzó antes',
    'inbox.night.rule.busy': 'estaba ocupado con esta terminal',
    'inbox.night.rule.notConnected': 'no puede comunicarse con este agente',
    'inbox.night.rule.notDelivered': 'el agente no confirmó el mensaje',
    'inbox.night.rule.timeout': 'tardó demasiado en decidir',
    'inbox.night.rule.stopped': 'se apagó el turno de noche',
    'inbox.night.rule.error': 'falló el decisor',
    'inbox.night.rule.invalid': 'su respuesta no calzaba',
    'inbox.night.rule.other': 'necesita tu revisión',
    // El diseño de teléfono (public/features/phone.js).
    'inbox.phone.title': 'Te esperan ({count})',
    'inbox.phone.live': 'En vivo',
    'inbox.phone.reconnecting': 'Reconectando…',
    'inbox.phone.signedOut': 'Sesión cerrada',
    'inbox.phone.toDeck': 'Terminales',
    'inbox.phone.toDeckLabel': 'Volver a las terminales',
    'inbox.phone.full': 'Abrir la interfaz completa',
    'inbox.phone.fullHint': 'Workspaces, archivos, piloto automático y ajustes.',
    'inbox.phone.toInbox': 'Te esperan',
    'inbox.phone.toInboxLabel': 'Volver a los agentes que te esperan',
  },
};
