// -----------------------------------------------------------------------------
// Every text of the integration, in English and French: the device names,
// the departure and alert texts published on the devices, and the status of
// the configuration screen. A refused field is named by its key, never echoed.
// The attribution 511 asks for, word for word ("data provided by 511.org",
// 511 Data Disseminator Agreement 5.b), is in the status and in the name of
// the first feature of each device, next to the data; the other features end
// with "(511.org)".
// -----------------------------------------------------------------------------

import { TIME_ZONE } from './constants.js';

export const LANGS = ['en', 'fr'];

const both = (en, fr) => ({ en, fr });

export const NAMES = {
  next: both(
    'Next departure (data provided by 511.org)',
    'Prochain départ (data provided by 511.org)',
  ),
  second: both('Following departure (511.org)', 'Départ suivant (511.org)'),
  departures: both('Departures within 60 min (511.org)', 'Départs dans les 60 min (511.org)'),
  alerts: both('Service alerts (511.org)', 'Alertes de service (511.org)'),
  alertText: both('Alert (511.org)', 'Alerte (511.org)'),
};

/** The text of a feature name in a language. */
export const t = (language, key) => NAMES[key][language] ?? NAMES[key].en;

/** The name of a stop device: the name typed, else the agency and the code. */
export function stopLabel(stop, language) {
  if (stop.name) return stop.name;
  return language === 'fr'
    ? `Arrêt ${stop.agency} ${stop.code}`
    : `${stop.agency} stop ${stop.code}`;
}

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** A time as hh:mm in the Bay Area. */
export const formatClock = (ms) => clockFormat.format(new Date(ms));

const bounded = (text, max) => [...text].slice(0, max).join('');

/** A line as riders know it: `14 MISSION` (Muni), `Caltrain Local`, `KT`. */
export function lineLabel({ line, lineName }) {
  if (!lineName || lineName.toLowerCase() === line.toLowerCase()) return line;
  if (lineName.toLowerCase().includes(line.toLowerCase())) return lineName;
  return `${line} ${lineName}`;
}

/** The text of a departure, or of its absence. */
export function departureText(departure, at, language, which, max) {
  const read = formatClock(at);
  if (!departure) {
    if (which === 'next') {
      return language === 'fr'
        ? `Aucun départ prévu (lu à ${read})`
        : `No predicted departure (read ${read})`;
    }
    return language === 'fr'
      ? `Pas de départ suivant (lu à ${read})`
      : `No following departure (read ${read})`;
  }
  const where = departure.destination
    ? `${lineLabel(departure)} → ${departure.destination}`
    : lineLabel(departure);
  const when =
    departure.minutes === 0
      ? language === 'fr'
        ? 'maintenant'
        : 'now'
      : `${departure.minutes} min`;
  const scheduled = departure.realtime ? '' : language === 'fr' ? ', horaire prévu' : ', scheduled';
  return bounded(`${where}: ${when} (${formatClock(departure.time)}${scheduled})`, max);
}

/** The text of the alerts in effect at a stop. */
export function alertText(alerts, at, language, max) {
  if (alerts.length === 0) {
    return language === 'fr'
      ? `Aucune alerte (lu à ${formatClock(at)})`
      : `No alert (read ${formatClock(at)})`;
  }
  const first =
    alerts[0].header || alerts[0].description || (language === 'fr' ? 'Alerte' : 'Alert');
  const more =
    alerts.length > 1
      ? language === 'fr'
        ? ` (+${alerts.length - 1} autre${alerts.length > 2 ? 's' : ''})`
        : ` (+${alerts.length - 1} more)`
      : '';
  return bounded(first, max - [...more].length) + more;
}

/** The status texts. */
export const M = {
  noKey: both(
    'Enter your 511 token (free, from 511.org/open-data/token).',
    'Saisissez votre jeton 511 (gratuit, sur 511.org/open-data/token).',
  ),
  noStop: both('No valid stop in the configuration.', 'Aucun arrêt valide dans la configuration.'),
  keyRefused: both(
    '511 refused the token (401): nothing is read until a new token is saved.',
    '511 a refusé le jeton (401) : rien n’est lu tant qu’un nouveau jeton n’est pas enregistré.',
  ),
  configRetry: ({ seconds }) =>
    both(
      `The configuration could not be read from Gladys; new try in ${seconds} s.`,
      `La configuration n’a pas pu être lue dans Gladys ; nouvel essai dans ${seconds} s.`,
    ),
  plan: ({ perHour, limit, depEvery, alertsEvery, raised }) =>
    both(
      `Plan: ${perHour} requests per hour at most for a limit of ${limit} (departures every ${depEvery} min${
        alertsEvery ? `, alerts every ${alertsEvery} min` : ', alerts off'
      }${raised ? ', interval lengthened for the quota' : ''}).`,
      `Plan : ${perHour} requêtes par heure au plus pour une limite de ${limit} (départs toutes les ${depEvery} min${
        alertsEvery ? `, alertes toutes les ${alertsEvery} min` : ', alertes désactivées'
      }${raised ? ', intervalle allongé pour le quota' : ''}).`,
    ),
  used: ({ used, budget }) =>
    both(
      `Requests in the last hour: ${used} (${budget} at most).`,
      `Requêtes de la dernière heure : ${used} (${budget} au plus).`,
    ),
  pause: ({ until, why }) =>
    both(
      `Reads paused until ${until} (${why.en}).`,
      `Lectures en pause jusqu’à ${until} (${why.fr}).`,
    ),
  dataUnknown: both(
    '/data cannot tell the requests sent before this start: the first reads wait one interval.',
    '/data ne dit pas les requêtes envoyées avant ce démarrage : les premières lectures attendent un intervalle.',
  ),
  dataNotSaved: both(
    '/data could not be written: a restart would wait one interval.',
    '/data n’a pas pu être écrit : un redémarrage attendrait un intervalle.',
  ),
  attribution: both('Data provided by 511.org.', 'Données fournies par 511.org.'),
};

/** Why a read failed, for the status. */
export function failure(kind, status) {
  const code = status ? ` ${status}` : '';
  switch (kind) {
    case 'network':
      return both('network error', 'erreur réseau');
    case 'timeout':
      return both('no answer within 20 s', 'pas de réponse en 20 s');
    case 'rate':
      return both('quota of the token reached (429)', 'quota du jeton atteint (429)');
    case 'server':
      return both(`511 error${code}`, `erreur de 511${code}`);
    case 'auth':
      return both('token refused (401)', 'jeton refusé (401)');
    case 'http':
      return both(`unexpected answer${code}`, `réponse inattendue${code}`);
    case 'not_found':
      return both(
        `stop or agency unknown to 511${code}, new try in 30 min`,
        `arrêt ou opérateur inconnu de 511${code}, nouvel essai dans 30 min`,
      );
    case 'format':
      return both('unreadable answer', 'réponse illisible');
    case 'unreadable':
      return both('a departure could not be read', 'un départ n’a pas pu être lu');
    case 'refused':
      return both('511 answered with an error status', '511 a répondu avec un statut d’erreur');
    case 'too_big':
      return both('answer too large', 'réponse trop grande');
    case 'clock':
      return both(
        'the time of 511 differs from the clock of this machine by more than 5 min',
        'l’heure de 511 diffère de plus de 5 min de l’horloge de cette machine',
      );
    case 'no_date':
      return both('answer without a time', 'réponse sans heure');
    case 'undated':
      return both('alerts feed without a time', 'flux d’alertes sans heure');
    case 'stale':
      return both('alerts feed not updated', 'flux d’alertes pas à jour');
    case 'paused':
      return both('paused', 'en pause');
    case 'quota':
      return both('skipped: the hourly quota is used up', 'sautée : le quota horaire est épuisé');
    case 'unconfirmed':
      return both(
        'no departure seen yet at this stop: check the agency and the stop code',
        'aucun départ encore vu à cet arrêt : vérifiez l’opérateur et le code de l’arrêt',
      );
    case 'lines_unknown':
      return both(
        'alerts wait for a first departure (lines of the stop unknown)',
        'alertes en attente d’un premier départ (lignes de l’arrêt inconnues)',
      );
    default:
      return both('not read yet', 'pas encore lu');
  }
}

const FIELD_ERRORS = {
  required: both('required', 'obligatoire'),
  key_invalid: both('not a 511 token', 'pas un jeton 511'),
  agency_invalid: both('not an operator id', 'pas un identifiant d’opérateur'),
  code_invalid: both('not a stop code', 'pas un code d’arrêt'),
  lines_invalid: both('invalid line', 'ligne invalide'),
  lines_too_many: both('10 lines at most', '10 lignes au plus'),
  name_invalid: both('invalid name', 'nom invalide'),
  refresh: both('2 to 60 minutes', '2 à 60 minutes'),
  limit: both('20 to 1000, default 60 used', '20 à 1000, 60 par défaut utilisé'),
  alerts: both('on or off', 'oui ou non'),
  duplicate: both('same stop as another slot', 'même arrêt qu’un autre emplacement'),
};

/** The refused fields, by key (never their value). */
export function configErrors(errors) {
  if (errors.length === 0) return both('', '');
  const list = (lang) =>
    errors.map((e) => `${e.field} (${FIELD_ERRORS[e.code]?.[lang] ?? e.code})`).join(', ');
  return both(`Refused: ${list('en')}.`, `Refusé : ${list('fr')}.`);
}
