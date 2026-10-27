// Pure helpers for turning Venus OS MQTT topics into a circuit model and
// converting values between Victron and Matter. No I/O here, so everything is
// unit-testable without a GX device or a Matter stack.

// Venus OS publishes each digital switching channel (SwitchableOutput) as
//   N/<portalId>/<service>/<instance>/SwitchableOutput/<channel>/<field...>
// where <service> is `switch` for switching modules (e.g. Energy Solutions /
// StarPower) or `system` for the GX's own relays. Relevant fields:
//   State                  0/1 (null when the output isn't controllable)
//   Dimming                0..100 brightness, dimmable outputs only
//   Name                   driver default name
//   Settings/CustomName    user-assigned name (may be empty)
//   Settings/Type          output type, see VICTRON_TYPES
//   Settings/Group         UI group name, e.g. "Bilge Pumps"
//   Settings/ShowUIControl 0 = hidden in all UIs
//   Settings/ValidTypes    bitmask of allowed types; 0 = not controllable
//   Status                 bit flags, see STATUS_FAULTS
// Each switching module also publishes N/<portalId>/switch/<instance>/CustomName
// (module name) and .../Connected (0 while the module is offline).
const SWITCH_TOPIC_RE = /^N\/([^/]+)\/(switch|system)\/(\d+)\/SwitchableOutput\/([^/]+)\/(.+)$/;
const BANK_TOPIC_RE = /^N\/([^/]+)\/switch\/(\d+)\/(CustomName|Connected)$/;

// Victron /Settings/Type values (venus wiki, dbus "switch" section).
const VICTRON_TYPES = {
  MOMENTARY: 0,
  TOGGLE: 1,
  DIMMABLE: 2,
};

// /SwitchableOutput/x/Status bits worth surfacing. 0x01 (powered) and 0x08
// (set alongside "on" in practice, e.g. Status 9) are normal operation.
const STATUS_FAULTS = [
  [0x02, 'Tripped'],
  [0x04, 'Over temperature'],
  [0x10, 'Short circuit'],
  [0x20, 'Disabled'],
];

// Matter LevelControl uses 1..254 for "on" brightness (0 and 255 are reserved).
const MATTER_LEVEL_MIN = 1;
const MATTER_LEVEL_MAX = 254;

const DEVICE_TYPES = ['auto', 'light', 'dimmableLight', 'outlet'];

// Toggle outputs that look like lighting become on/off lights; everything else
// (pumps, fridges, electronics) becomes an outlet so it shows up in Home apps as
// a switchable device rather than a lamp. The circuit's own name is checked
// before its group, since groups are often by location ("Port Hull Lighting"
// can contain the fans).
const LIGHT_NAME_RE = /light|lamp|\bled\b|courtesy|spot/i;
const NON_LIGHT_NAME_RE
  = /pump|fan|fridge|refrig|freez|heater|inverter|charger|audio|stereo|amplifier|\btv\b|electronic|nmea|instrument|outlet|socket|windlass|winch|horn|watermaker/i;

function parseSwitchTopic(topic) {
  const m = SWITCH_TOPIC_RE.exec(topic);
  if (!m) return null;
  const [, portalId, service, instance, channel, field] = m;
  return { portalId, service, instance, channel, field, id: `${service}.${instance}.${channel}` };
}

function parseBankTopic(topic) {
  const m = BANK_TOPIC_RE.exec(topic);
  if (!m) return null;
  return { portalId: m[1], bankKey: `switch.${m[2]}`, field: m[3] };
}

function bankKeyOf(circuit) {
  return `${circuit.service}.${circuit.instance}`;
}

function statusFaults(status) {
  if (typeof status !== 'number') return [];
  return STATUS_FAULTS.filter(([bit]) => status & bit).map(([, label]) => label);
}

function createCircuit({ id, service, instance, channel }) {
  return {
    id,
    service,
    instance,
    channel,
    name: undefined,
    customName: undefined,
    group: undefined,
    type: undefined,
    validTypes: undefined,
    showUIControl: undefined,
    state: undefined,
    dimming: undefined,
    status: undefined,
  };
}

// Apply one MQTT field update to a circuit. Returns true if a value Matter
// cares about (state or dimming) changed, so the caller can push it to the bridge.
function applyField(circuit, field, value) {
  switch (field) {
    case 'State':
      circuit.state = value === null || value === undefined ? null : Boolean(value);
      return true;
    case 'Dimming':
      circuit.dimming = typeof value === 'number' ? value : undefined;
      return true;
    case 'Name':
      circuit.name = value || undefined;
      return false;
    case 'Settings/CustomName':
      circuit.customName = value || undefined;
      return false;
    case 'Settings/Group':
      circuit.group = value || undefined;
      return false;
    case 'Settings/Type':
      circuit.type = typeof value === 'number' ? value : undefined;
      return false;
    case 'Settings/ValidTypes':
      circuit.validTypes = typeof value === 'number' ? value : undefined;
      return false;
    case 'Settings/ShowUIControl':
      circuit.showUIControl = typeof value === 'number' ? value : undefined;
      return false;
    case 'Status':
      circuit.status = typeof value === 'number' ? value : undefined;
      return false;
    default:
      return false;
  }
}

const SUPPORTED_TYPES = [VICTRON_TYPES.MOMENTARY, VICTRON_TYPES.TOGGLE, VICTRON_TYPES.DIMMABLE];

function isMomentary(circuit) {
  return circuit.type === VICTRON_TYPES.MOMENTARY;
}

// Whether a circuit can be represented in Matter at all. Stepped, dropdown,
// slider, etc. outputs are skipped for now, as are outputs that are hidden in
// all Victron UIs or not currently controllable (e.g. GX relays assigned to
// another function report State = null).
//
// `alreadyBridged` keeps a bridged circuit whose State went null (module
// offline, GX restarting): it is shown as unreachable instead of being removed,
// which would make Home apps forget its room and automations.
function isBridgeable(circuit, alreadyBridged = false) {
  if (!SUPPORTED_TYPES.includes(circuit.type)) return false;
  if (!alreadyBridged && (circuit.state === null || circuit.state === undefined)) return false;
  if (circuit.validTypes === 0) return false;
  if (circuit.showUIControl === 0) return false;
  return true;
}

// Momentary outputs (horns, windlass up/down, ...) are opt-in: exposing them to
// phone apps and home automations should be a deliberate choice. Everything else
// is exposed unless the user turned it off.
function isEnabled(circuit, override) {
  if (override && typeof override.enabled === 'boolean') return override.enabled;
  return !isMomentary(circuit);
}

function circuitLabel(circuit, bankNames = {}) {
  if (circuit.customName) return circuit.customName;
  if (circuit.name) return circuit.name;
  const bank = bankNames[`${circuit.service}.${circuit.instance}`] || `${circuit.service} ${circuit.instance}`;
  return `${bank} ${circuit.channel}`;
}

// Resolve which Matter device type a circuit should be exposed as. User overrides
// win; otherwise it follows the Victron output type and the circuit's name/group.
function resolveDeviceType(circuit, override, label) {
  if (override && override !== 'auto' && DEVICE_TYPES.includes(override)) {
    // Only a dimmable output can actually dim; anything else would show a
    // brightness slider in the Home app that does nothing.
    if (override === 'dimmableLight' && circuit.type !== VICTRON_TYPES.DIMMABLE) return 'light';
    return override;
  }
  if (circuit.type === VICTRON_TYPES.DIMMABLE) return 'dimmableLight';
  if (LIGHT_NAME_RE.test(label || '')) return 'light';
  if (NON_LIGHT_NAME_RE.test(label || '')) return 'outlet';
  return LIGHT_NAME_RE.test(circuit.group || '') ? 'light' : 'outlet';
}

// Merge discovered circuits with the user's per-circuit config. Returns only the
// circuits that should be bridged, each with its final label and device type.
function buildBridgedCircuits(discovered, circuitConfig = [], bankNames = {}, isBridged = () => false) {
  const overrides = new Map((circuitConfig || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const result = [];
  for (const circuit of discovered) {
    if (!isBridgeable(circuit, isBridged(circuit.id))) continue;
    const o = overrides.get(circuit.id) || {};
    if (!isEnabled(circuit, o)) continue;
    const label = (o.name && o.name.trim()) || circuitLabel(circuit, bankNames);
    result.push({
      ...circuit,
      label,
      deviceType: resolveDeviceType(circuit, o.deviceType, label),
    });
  }
  return result;
}

// Why an output isn't bridged, for display in the config panel (null if it is bridgeable).
function skipReason(circuit) {
  if (circuit.showUIControl === 0) return 'Hidden in the Victron UI';
  if (circuit.validTypes === 0) return 'Not controllable';
  if (circuit.type === undefined) return 'Waiting for output type';
  if (!SUPPORTED_TYPES.includes(circuit.type)) return 'Output type not supported yet';
  if (circuit.state === null || circuit.state === undefined) return 'Not available (e.g. relay assigned to another function)';
  return null;
}

// Everything the config panel needs to list circuits and edit overrides:
// discovered outputs (supported or not), their automatic label and device type,
// the current override, and whether each one is live on the bridge right now.
function buildCircuitReport(discovered, circuitConfig = [], bankNames = {}, isBridged = () => false) {
  const overrides = new Map((circuitConfig || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  return discovered
    .map((circuit) => {
      const autoLabel = circuitLabel(circuit, bankNames);
      const o = overrides.get(circuit.id) || {};
      return {
        id: circuit.id,
        bank:
          circuit.service === 'system'
            ? 'GX Device'
            : bankNames[`${circuit.service}.${circuit.instance}`] || `Switch module ${circuit.instance}`,
        channel: circuit.channel,
        group: circuit.group || null,
        victronType: circuit.type === undefined ? null : circuit.type,
        dimmable: circuit.type === VICTRON_TYPES.DIMMABLE,
        momentary: isMomentary(circuit),
        state: circuit.state === undefined ? null : circuit.state,
        faults: statusFaults(circuit.status),
        autoLabel,
        autoDeviceType: resolveDeviceType(circuit, undefined, autoLabel),
        skipReason: skipReason(circuit),
        override: { name: o.name || '', deviceType: o.deviceType || 'auto', enabled: isEnabled(circuit, o) },
        bridged: isBridged(circuit.id),
      };
    })
    .sort((a, b) => a.bank.localeCompare(b.bank) || Number(a.channel) - Number(b.channel));
}

// The bridged-circuit cache lets the bridge re-create its endpoints right after a
// restart, before the GX has republished anything, so controllers reconnecting
// in that window see the accessories (as unreachable) rather than an empty
// bridge. Only the fields that drive the label and device type are kept; state
// always comes fresh from the GX.
const CACHED_FIELDS = ['id', 'service', 'instance', 'channel', 'name', 'customName', 'group', 'type', 'validTypes', 'showUIControl'];

function toCacheEntry(circuit, bankNames = {}) {
  const entry = {};
  for (const key of CACHED_FIELDS) {
    if (circuit[key] !== undefined) entry[key] = circuit[key];
  }
  const bankName = bankNames[bankKeyOf(circuit)];
  if (bankName) entry.bankName = bankName;
  return entry;
}

// Returns { circuit, bankName } or null for a malformed entry.
function fromCacheEntry(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.service || entry.instance === undefined || entry.channel === undefined) {
    return null;
  }
  const circuit = createCircuit(entry);
  for (const key of CACHED_FIELDS) {
    if (entry[key] !== undefined) circuit[key] = entry[key];
  }
  return { circuit, bankName: entry.bankName };
}

function percentToMatterLevel(percent) {
  if (typeof percent !== 'number' || Number.isNaN(percent)) return MATTER_LEVEL_MAX;
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.max(MATTER_LEVEL_MIN, Math.round((clamped / 100) * MATTER_LEVEL_MAX));
}

function matterLevelToPercent(level) {
  if (typeof level !== 'number' || Number.isNaN(level)) return 0;
  const clamped = Math.min(MATTER_LEVEL_MAX, Math.max(MATTER_LEVEL_MIN, level));
  return Math.round((clamped / MATTER_LEVEL_MAX) * 100);
}

// Matter endpoint ids must be stable across restarts (controllers key their
// accessories off them) and may not contain dots. Ids are based on the hardware
// channel, not the name, so renaming a circuit on the GX keeps its pairing.
function endpointIdFor(circuitId) {
  return `circuit-${circuitId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

module.exports = {
  VICTRON_TYPES,
  DEVICE_TYPES,
  MATTER_LEVEL_MIN,
  MATTER_LEVEL_MAX,
  parseSwitchTopic,
  parseBankTopic,
  bankKeyOf,
  statusFaults,
  isMomentary,
  isEnabled,
  toCacheEntry,
  fromCacheEntry,
  createCircuit,
  applyField,
  isBridgeable,
  circuitLabel,
  resolveDeviceType,
  buildBridgedCircuits,
  skipReason,
  buildCircuitReport,
  percentToMatterLevel,
  matterLevelToPercent,
  endpointIdFor,
};
