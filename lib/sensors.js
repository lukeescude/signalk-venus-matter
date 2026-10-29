// Pure helpers for the GX's read-only sensors (tank senders and temperature
// probes): MQTT topic parsing, the sensor model, labels, and the mapping onto
// Matter measurement values. No I/O here.
//
// Venus OS publishes each sensor (dbus com.victronenergy.<kind>) as
//   N/<portalId>/<kind>/<instance>/<field>
// Fields common to both kinds:
//   CustomName  user-assigned name (may be empty)
//   ProductName e.g. "Mopeka Pro", "GX Tank 140", "Generic Temperature Input"
//   Status      0 = OK, otherwise a sensor fault (see SENSOR_STATUS)
//   Connected   0 while the sensor is offline
// plus the kind's value and type fields (see SENSOR_KINDS). Only these are
// subscribed to: the services also publish RawValue and friends, which change
// constantly.

// Tank /FluidType values (venus wiki, dbus "tank" section).
const FLUID_TYPES = {
  0: 'Fuel',
  1: 'Fresh water',
  2: 'Waste water',
  3: 'Live well',
  4: 'Oil',
  5: 'Black water',
  6: 'Gasoline',
  7: 'Diesel',
  8: 'LPG',
  9: 'LNG',
  10: 'Hydraulic oil',
  11: 'Raw water',
};

// Temperature /TemperatureType values (venus wiki, dbus "temperature" section).
const TEMPERATURE_TYPES = {
  0: 'Battery',
  1: 'Fridge',
  2: 'Generic',
  3: 'Room',
  4: 'Outdoor',
  5: 'Water heater',
  6: 'Freezer',
};

const SENSOR_STATUS = {
  1: 'Sensor disconnected',
  2: 'Sensor short circuited',
  3: 'Reverse polarity',
  4: 'Unknown sensor fault',
  5: 'Sensor error',
};

// Matter RelativeHumidityMeasurement.measuredValue is in 0.01 % steps.
const HUMIDITY_MAX = 10000;

// Whole percent only: tank senders are noisy, and sub-percent changes would
// just churn the Matter fabric. Matter has no tank or level device type, and a
// humidity sensor is the closest read-only 0..100 % one, so that's what a tank
// becomes.
function levelToHumidity(level) {
  if (typeof level !== 'number' || Number.isNaN(level)) return null;
  return Math.round(Math.min(100, Math.max(0, level))) * 100;
}

// Matter TemperatureMeasurement.measuredValue is int16 in 0.01 °C steps.
// Rounded to 0.1 °C for the same reason as tank levels.
function celsiusToMatter(celsius) {
  if (typeof celsius !== 'number' || Number.isNaN(celsius)) return null;
  return Math.min(32767, Math.max(-27315, Math.round(celsius * 10) * 10));
}

// Per-kind description. `settingsKey` is the plugin config array holding the
// per-sensor overrides.
const SENSOR_KINDS = {
  tank: {
    settingsKey: 'tanks',
    valueField: 'Level',
    typeField: 'FluidType',
    extraFields: ['Capacity', 'Remaining'],
    typeNames: FLUID_TYPES,
    autoLabel: (typeName) => `${typeName} tank`,
    fallbackLabel: 'Tank',
    toMatter: levelToHumidity,
  },
  temperature: {
    settingsKey: 'temperatures',
    valueField: 'Temperature',
    typeField: 'TemperatureType',
    extraFields: [],
    typeNames: TEMPERATURE_TYPES,
    autoLabel: (typeName) =>
      ['Fridge', 'Freezer', 'Water heater'].includes(typeName) ? typeName : `${typeName} temperature`,
    fallbackLabel: 'Temperature',
    toMatter: celsiusToMatter,
  },
};
const SENSOR_KIND_NAMES = Object.keys(SENSOR_KINDS);

function fieldsOf(kind) {
  const k = SENSOR_KINDS[kind];
  return [k.valueField, k.typeField, 'CustomName', 'ProductName', 'Status', 'Connected', ...k.extraFields];
}

// MQTT subscriptions for every sensor kind, given the portal id.
function sensorTopics(portalId) {
  return SENSOR_KIND_NAMES.flatMap((kind) => fieldsOf(kind).map((field) => `N/${portalId}/${kind}/+/${field}`));
}

const SENSOR_TOPIC_RE = /^N\/([^/]+)\/([a-z]+)\/(\d+)\/(.+)$/;

function parseSensorTopic(topic) {
  const m = SENSOR_TOPIC_RE.exec(topic);
  if (!m) return null;
  const [, portalId, kind, instance, field] = m;
  if (!SENSOR_KINDS[kind] || !fieldsOf(kind).includes(field)) return null;
  return { portalId, kind, instance, field, id: `${kind}.${instance}` };
}

function createSensor({ id, kind, instance }) {
  return {
    id,
    kind,
    instance,
    value: undefined,
    sensorType: undefined,
    customName: undefined,
    productName: undefined,
    status: undefined,
    connected: undefined,
    capacity: undefined,
    remaining: undefined,
  };
}

// Apply one MQTT field update to a sensor. Returns true if its value changed,
// so the caller can push it to the bridge.
function applySensorField(sensor, field, value) {
  const number = typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
  const { valueField, typeField } = SENSOR_KINDS[sensor.kind];
  switch (field) {
    case valueField: {
      const before = sensor.value;
      sensor.value = number;
      return sensor.value !== before;
    }
    case typeField:
      sensor.sensorType = number;
      return false;
    case 'CustomName':
      sensor.customName = value || undefined;
      return false;
    case 'ProductName':
      sensor.productName = value || undefined;
      return false;
    case 'Status':
      sensor.status = number;
      return false;
    case 'Connected':
      sensor.connected = value !== 0 && value !== null;
      return false;
    case 'Capacity':
      sensor.capacity = number;
      return false;
    case 'Remaining':
      sensor.remaining = number;
      return false;
    default:
      return false;
  }
}

function typeNameOf(sensor) {
  return SENSOR_KINDS[sensor.kind].typeNames[sensor.sensorType] || null;
}

function sensorLabel(sensor) {
  if (sensor.customName) return sensor.customName;
  const k = SENSOR_KINDS[sensor.kind];
  const typeName = typeNameOf(sensor);
  return typeName ? k.autoLabel(typeName) : `${k.fallbackLabel} ${sensor.instance}`;
}

// Automatic labels for a set of sensors, keyed by id. Labels shared by several
// sensors (three probes all typed "Fridge") get the instance appended so they
// can be told apart; the instance is stable, unlike a running number.
function autoLabels(sensors) {
  const labels = new Map(sensors.map((s) => [s.id, sensorLabel(s)]));
  const counts = new Map();
  for (const label of labels.values()) counts.set(label, (counts.get(label) || 0) + 1);
  for (const s of sensors) {
    const label = labels.get(s.id);
    if (counts.get(label) > 1 && !s.customName) labels.set(s.id, `${label} ${s.instance}`);
  }
  return labels;
}

function sensorFault(sensor) {
  if (sensor.connected === false) return 'Sensor offline';
  return SENSOR_STATUS[sensor.status] || null;
}

// A sensor is bridged once it has reported a value. `alreadyBridged` keeps a
// bridged sensor whose value went away (sensor offline): it is shown as
// unreachable instead of being removed, so Home apps keep its room.
function isSensorBridgeable(sensor, alreadyBridged = false) {
  return alreadyBridged || typeof sensor.value === 'number';
}

// Sensors are exposed unless the user turned them off.
function isSensorEnabled(override) {
  return !(override && override.enabled === false);
}

function overridesFrom(settings = {}) {
  const map = new Map();
  for (const kind of SENSOR_KIND_NAMES) {
    for (const o of settings[SENSOR_KINDS[kind].settingsKey] || []) {
      if (o && o.id) map.set(o.id, o);
    }
  }
  return map;
}

// Merge discovered sensors with the user's per-sensor config (the whole plugin
// settings object). Returns only the sensors that should be bridged, each with
// its final label.
function buildBridgedSensors(discovered, settings = {}, isBridged = () => false) {
  const overrides = overridesFrom(settings);
  const labels = autoLabels(discovered);
  const result = [];
  for (const sensor of discovered) {
    if (!isSensorBridgeable(sensor, isBridged(sensor.id))) continue;
    const o = overrides.get(sensor.id) || {};
    if (!isSensorEnabled(o)) continue;
    result.push({ ...sensor, label: (o.name && o.name.trim()) || labels.get(sensor.id) });
  }
  return result;
}

// m³ on the GX; litres are what people read on a tank.
function litres(m3) {
  return typeof m3 === 'number' ? Math.round(m3 * 1000) : null;
}

// Everything the config panel needs to list sensors and edit overrides.
function buildSensorReport(discovered, settings = {}, isBridged = () => false) {
  const overrides = overridesFrom(settings);
  const labels = autoLabels(discovered);
  return discovered
    .map((sensor) => {
      const o = overrides.get(sensor.id) || {};
      return {
        id: sensor.id,
        kind: sensor.kind,
        instance: sensor.instance,
        typeName: typeNameOf(sensor),
        value: sensor.value === undefined ? null : sensor.value,
        capacityLitres: litres(sensor.capacity),
        remainingLitres: litres(sensor.remaining),
        productName: sensor.productName || null,
        fault: sensorFault(sensor),
        autoLabel: labels.get(sensor.id),
        skipReason: isSensorBridgeable(sensor) ? null : 'Waiting for a reading',
        override: { name: o.name || '', enabled: isSensorEnabled(o) },
        bridged: isBridged(sensor.id),
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || Number(a.instance) - Number(b.instance));
}

// Same idea as the circuit cache: keep what drives the label, never the value.
const CACHED_SENSOR_FIELDS = ['id', 'kind', 'instance', 'sensorType', 'customName', 'productName', 'capacity'];

function toSensorCacheEntry(sensor) {
  const entry = {};
  for (const key of CACHED_SENSOR_FIELDS) {
    if (sensor[key] !== undefined) entry[key] = sensor[key];
  }
  return entry;
}

function fromSensorCacheEntry(entry) {
  if (!entry || typeof entry.id !== 'string' || !SENSOR_KINDS[entry.kind] || entry.instance === undefined) return null;
  const sensor = createSensor(entry);
  for (const key of CACHED_SENSOR_FIELDS) {
    if (entry[key] !== undefined) sensor[key] = entry[key];
  }
  return sensor;
}

// The Matter measuredValue for a sensor's current value (null when unknown).
function toMatterValue(kind, value) {
  return SENSOR_KINDS[kind].toMatter(value);
}

// Stable across restarts and based on the instance, like circuit ids.
function sensorEndpointIdFor(sensorId) {
  return sensorId.replace(/[^A-Za-z0-9_-]/g, '-');
}

module.exports = {
  FLUID_TYPES,
  TEMPERATURE_TYPES,
  HUMIDITY_MAX,
  SENSOR_KINDS,
  SENSOR_KIND_NAMES,
  sensorTopics,
  parseSensorTopic,
  createSensor,
  applySensorField,
  sensorLabel,
  autoLabels,
  sensorFault,
  isSensorBridgeable,
  isSensorEnabled,
  buildBridgedSensors,
  buildSensorReport,
  toSensorCacheEntry,
  fromSensorCacheEntry,
  levelToHumidity,
  celsiusToMatter,
  toMatterValue,
  sensorEndpointIdFor,
};
