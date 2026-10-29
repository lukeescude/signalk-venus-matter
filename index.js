const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QRCode = require('qrcode');

const {
  DEVICE_TYPES,
  parseSwitchTopic,
  parseBankTopic,
  bankKeyOf,
  isMomentary,
  isEnabled,
  toCacheEntry,
  fromCacheEntry,
  createCircuit,
  applyField,
  buildBridgedCircuits,
  buildCircuitReport,
} = require('./lib/circuits');
const {
  SENSOR_KINDS,
  SENSOR_KIND_NAMES,
  parseSensorTopic,
  createSensor,
  applySensorField,
  buildBridgedSensors,
  buildSensorReport,
  toSensorCacheEntry,
  fromSensorCacheEntry,
} = require('./lib/sensors');

const PLUGIN_ID = 'signalk-venus-matter';
const DEFAULT_PORT = 5540;
const DEFAULT_GX_PORT = 1883;
const DEFAULT_GX_TLS_PORT = 8883;
const DEFAULT_BRIDGE_NAME = 'Signal K Bridge';

// A circuit's fields (State, Type, Name, ...) arrive as separate MQTT messages
// during the GX's full republish. Wait for things to settle before adding new
// endpoints so a circuit is bridged with its final type and name.
const DISCOVERY_SETTLE_MS = 3000;

// How long a momentary output is held on when tapped in a Matter app.
const MOMENTARY_PULSE_MS = 500;

// Tank levels slosh around underway and temperature probes drift constantly.
// Push at most one value change per sensor in this window (the latest value
// wins), so the Matter fabric isn't flooded.
const SENSOR_UPDATE_MIN_MS = 15000;

// Matter forbids these setup passcodes (spec 5.1.7.1).
const INVALID_PASSCODES = new Set([
  0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999,
  12345678, 87654321,
]);

function isValidPasscode(passcode) {
  return Number.isInteger(passcode) && passcode >= 1 && passcode <= 99999998 && !INVALID_PASSCODES.has(passcode);
}

function randomPasscode() {
  let passcode;
  do {
    passcode = crypto.randomInt(1, 99999999);
  } while (!isValidPasscode(passcode));
  return passcode;
}

// Bridge identity (unique id, default passcode/discriminator) is generated once
// and kept in the plugin data dir so a paired bridge keeps working across restarts.
// Well-known Matter vendor ids of controller ecosystems, for showing which apps
// the bridge is paired with.
const CONTROLLER_VENDORS = {
  0x1349: 'Apple Home',
  0x1384: 'Apple',
  0x6006: 'Google Home',
  0x1217: 'Amazon Alexa',
  0x110a: 'SmartThings',
};

function describeFabric({ fabricIndex, vendorId, label }) {
  const vendor = CONTROLLER_VENDORS[vendorId] || `Vendor 0x${Number(vendorId).toString(16).padStart(4, '0')}`;
  return { fabricIndex, vendorId, vendor, label: label || '' };
}

// If no GX address is configured, borrow it from signalk-venus-plugin's config
// (plugin id "venus"), which most Victron users already have set up. Returns
// { host, tls } or null.
function detectGxFromVenusPlugin(dataDir) {
  try {
    const file = path.join(path.dirname(dataDir), 'venus.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8')).configuration || {};
    switch (config.installType) {
      case 'mqtt':
      case 'mqtts':
        return config.MQTT && config.MQTT.host ? { host: config.MQTT.host, tls: config.installType === 'mqtts' } : null;
      case 'local':
        // Signal K is running on the GX itself.
        return { host: '127.0.0.1', tls: false };
      case 'remote': {
        const m = /host=([^,]+)/.exec(config.dbusAddress || '');
        return m ? { host: m[1], tls: false } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const IDENTITY_FILE = 'bridge-identity.json';
const CIRCUIT_CACHE_FILE = 'bridged-circuits.json';
const SENSOR_CACHE_FILE = 'bridged-sensors.json';

function loadCircuitCache(dataDir) {
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(dataDir, CIRCUIT_CACHE_FILE), 'utf8'));
    return Array.isArray(entries) ? entries.map(fromCacheEntry).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function loadSensorCache(dataDir) {
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(dataDir, SENSOR_CACHE_FILE), 'utf8'));
    return Array.isArray(entries) ? entries.map(fromSensorCacheEntry).filter(Boolean) : [];
  } catch {
    return [];
  }
}
const MATTER_STORAGE_DIR = 'matter';

function loadOrCreateIdentity(dataDir) {
  const file = path.join(dataDir, IDENTITY_FILE);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const identity = {
      uniqueId: crypto.randomBytes(8).toString('hex'),
      passcode: randomPasscode(),
      discriminator: crypto.randomInt(0, 4096),
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(identity, null, 2));
    return identity;
  }
}

module.exports = function (app) {
  const plugin = {
    id: PLUGIN_ID,
    name: 'Matter Bridge for Victron Switching',
    description: 'Expose Victron digital switching circuits as Matter devices.',
  };

  let venus = null;
  let bridge = null;
  let settleTimer = null;
  let syncing = Promise.resolve();
  let stopped = true;
  let currentSettings = {};
  let gxConnected = false;
  let gxHostSource = null; // 'settings' | 'venus-plugin' | null
  // circuit id ("switch.0.6") -> circuit model
  const discovered = new Map();
  // bank key ("switch.0") -> bank CustomName, e.g. "Port Elec 1 (86:DA)"
  const bankNames = {};
  // bank key -> false while that switching module is offline
  const bankConnected = {};
  // circuit id -> pending momentary release timer
  const momentaryTimers = new Map();
  // circuit id -> { circuit, bankName } restored from the cache at startup and
  // not (yet) reported by the GX
  const restored = new Map();
  let lastCacheJson = null;
  // sensor id ("tank.20", "temperature.24") -> sensor model
  const discoveredSensors = new Map();
  // sensor id -> sensor restored from the cache and not (yet) reported by the GX
  const restoredSensors = new Map();
  // sensor id -> { at, timer } for rate-limiting value updates
  const sensorPushes = new Map();
  let lastSensorCacheJson = null;

  function saveCircuitCache() {
    if (!bridge) return;
    const entries = bridge
      .ids('circuit')
      .map((id) => {
        if (discovered.has(id)) return toCacheEntry(discovered.get(id), bankNames);
        const r = restored.get(id);
        return r ? toCacheEntry(r.circuit, { [bankKeyOf(r.circuit)]: r.bankName }) : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id));
    const json = JSON.stringify(entries, null, 2);
    if (json === lastCacheJson) return;
    try {
      fs.writeFileSync(path.join(app.getDataDirPath(), CIRCUIT_CACHE_FILE), json);
      lastCacheJson = json;
    } catch (err) {
      app.error(`Failed to save bridged circuit cache: ${err.message}`);
    }
  }

  function saveSensorCache() {
    if (!bridge) return;
    const entries = bridge
      .ids(...SENSOR_KIND_NAMES)
      .map((id) => discoveredSensors.get(id) || restoredSensors.get(id))
      .filter(Boolean)
      .map(toSensorCacheEntry)
      .sort((a, b) => a.id.localeCompare(b.id));
    const json = JSON.stringify(entries, null, 2);
    if (json === lastSensorCacheJson) return;
    try {
      fs.writeFileSync(path.join(app.getDataDirPath(), SENSOR_CACHE_FILE), json);
      lastSensorCacheJson = json;
    } catch (err) {
      app.error(`Failed to save bridged sensor cache: ${err.message}`);
    }
  }

  // Re-create last session's endpoints immediately (unreachable until the GX
  // reports their state), so a controller reconnecting right after a restart
  // finds its accessories instead of an empty bridge.
  async function restoreCachedCircuits(settings) {
    const cached = loadCircuitCache(app.getDataDirPath());
    const names = {};
    for (const { circuit, bankName } of cached) {
      if (bankName) names[bankKeyOf(circuit)] = bankName;
    }
    const circuits = buildBridgedCircuits(
      cached.map((c) => c.circuit),
      settings.circuits,
      names,
      () => true,
    );
    for (const circuit of circuits) {
      restored.set(circuit.id, { circuit, bankName: names[bankKeyOf(circuit)] });
      await bridge.addCircuit(circuit, false);
    }
    if (circuits.length) app.debug(`Restored ${circuits.length} circuit(s) from the last session`);
  }

  async function restoreCachedSensors(settings) {
    const sensors = buildBridgedSensors(loadSensorCache(app.getDataDirPath()), settings, () => true);
    for (const sensor of sensors) {
      restoredSensors.set(sensor.id, sensor);
      await bridge.addSensor(sensor, false);
    }
    if (sensors.length) app.debug(`Restored ${sensors.length} sensor(s) from the last session`);
  }

  function isReachable(circuit) {
    if (!gxConnected || !circuit) return false;
    if (bankConnected[bankKeyOf(circuit)] === false) return false;
    return circuit.state !== null && circuit.state !== undefined;
  }

  function isSensorReachable(sensor) {
    if (!gxConnected || !sensor) return false;
    if (sensor.connected === false) return false;
    if (sensor.status !== undefined && sensor.status !== 0) return false;
    return typeof sensor.value === 'number';
  }

  function refreshReachability() {
    if (!bridge) return;
    for (const [id, { kind }] of bridge.endpoints) {
      const reachable = kind === 'circuit' ? isReachable(discovered.get(id)) : isSensorReachable(discoveredSensors.get(id));
      bridge.setReachable(id, reachable).catch((err) => {
        app.error(`Failed to update reachability of ${id}: ${err.message}`);
      });
    }
  }

  function describeBridged() {
    const counts = [`${bridge.ids('circuit').length} circuit(s)`];
    const tanks = bridge.ids('tank').length;
    const temperatures = bridge.ids('temperature').length;
    if (tanks) counts.push(`${tanks} tank(s)`);
    if (temperatures) counts.push(`${temperatures} temperature sensor(s)`);
    return counts.length > 1 ? `${counts.slice(0, -1).join(', ')} and ${counts[counts.length - 1]}` : counts[0];
  }

  function updateStatus() {
    if (!bridge) return;
    const count = describeBridged();
    const gx = gxConnected ? '' : ' — GX not connected';
    if (bridge.isCommissioned) {
      app.setPluginStatus(`Paired — bridging ${count}${gx}`);
    } else {
      const codes = bridge.pairingCodes;
      app.setPluginStatus(
        `Waiting to be paired — bridging ${count}. Pairing code: ${codes ? codes.manualPairingCode : '?'}${gx}`,
      );
    }
  }

  function scheduleSync(settings) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      // Serialize syncs so overlapping timers never add the same endpoint twice.
      syncing = syncing.then(() => syncEndpoints(settings)).catch((err) => {
        app.error(`Failed to sync Matter endpoints: ${err.message}`);
      });
    }, DISCOVERY_SETTLE_MS);
  }

  // Bring the bridge in line with what the GX reports: add new circuits, remove
  // ones that were hidden or retyped to something unsupported, rebuild ones whose
  // Matter device type changed, and rename ones whose label changed.
  async function syncEndpoints(settings) {
    if (stopped || !bridge) return;
    const desired = buildBridgedCircuits([...discovered.values()], settings.circuits, bankNames, (id) =>
      bridge.has(id),
    );
    const desiredIds = new Set(desired.map((c) => c.id));
    const overrides = new Map((settings.circuits || []).filter((c) => c && c.id).map((c) => [c.id, c]));

    for (const id of bridge.ids('circuit')) {
      if (desiredIds.has(id)) continue;
      if (!discovered.has(id)) {
        // Restored from the cache but not reported by the GX (module offline,
        // or removed from the boat). Keep it as unreachable unless the user
        // explicitly turned it off.
        const r = restored.get(id);
        if (!r || isEnabled(r.circuit, overrides.get(id))) continue;
      }
      app.debug(`Removing ${id} from the bridge`);
      await bridge.removeCircuit(id);
      restored.delete(id);
    }
    for (const circuit of desired) {
      const current = bridge.get(circuit.id);
      if (current && current.deviceType !== circuit.deviceType) {
        app.debug(`Rebuilding ${circuit.id}: ${current.deviceType} -> ${circuit.deviceType}`);
        await bridge.removeCircuit(circuit.id);
      } else if (current) {
        await bridge.updateLabel(circuit.id, circuit.label);
        continue;
      }
      await bridge.addCircuit(circuit, isReachable(circuit));
    }
    for (const id of desiredIds) restored.delete(id);
    saveCircuitCache();
    await syncSensors(settings);
    updateStatus();
  }

  // Same as syncEndpoints, for sensors. A sensor's device type never changes,
  // so it is only ever added, removed, or renamed. Restored sensors the GX
  // hasn't reported are included, so they stay (unreachable) unless turned off
  // and are counted when telling same-named sensors apart.
  async function syncSensors(settings) {
    const known = [
      ...discoveredSensors.values(),
      ...[...restoredSensors.values()].filter((s) => !discoveredSensors.has(s.id)),
    ];
    const desired = buildBridgedSensors(known, settings, (id) => bridge.has(id));
    const desiredIds = new Set(desired.map((s) => s.id));

    for (const id of bridge.ids(...SENSOR_KIND_NAMES)) {
      if (desiredIds.has(id)) continue;
      app.debug(`Removing ${id} from the bridge`);
      await bridge.removeCircuit(id);
      restoredSensors.delete(id);
    }
    for (const sensor of desired) {
      if (bridge.has(sensor.id)) {
        await bridge.updateLabel(sensor.id, sensor.label);
      } else {
        await bridge.addSensor(sensor, isSensorReachable(sensor));
      }
      if (discoveredSensors.has(sensor.id)) restoredSensors.delete(sensor.id);
    }
    saveSensorCache();
  }

  function pushSensorValue(id) {
    const push = sensorPushes.get(id) || { at: 0, timer: null };
    sensorPushes.set(id, push);
    if (push.timer) return; // a trailing update is already scheduled
    const send = () => {
      push.timer = null;
      push.at = Date.now();
      const sensor = discoveredSensors.get(id);
      if (!bridge || !sensor || typeof sensor.value !== 'number') return;
      bridge.updateSensor(id, sensor.value).catch((err) => {
        app.error(`Failed to update Matter endpoint ${id}: ${err.message}`);
      });
    };
    const wait = push.at + SENSOR_UPDATE_MIN_MS - Date.now();
    if (wait <= 0) send();
    else push.timer = setTimeout(send, wait);
  }

  function handleSensorValue(settings, parsed, value) {
    let sensor = discoveredSensors.get(parsed.id);
    if (!sensor) {
      sensor = createSensor(parsed);
      discoveredSensors.set(parsed.id, sensor);
      app.debug(`Discovered ${parsed.kind} sensor ${parsed.id}`);
    }
    const { valueField, typeField } = SENSOR_KINDS[parsed.kind];
    const hadValue = typeof sensor.value === 'number';
    const valueChanged = applySensorField(sensor, parsed.field, value);
    const bridged = bridge && bridge.has(parsed.id);
    if (bridged) {
      if (valueChanged) pushSensorValue(parsed.id);
      if ([valueField, 'Status', 'Connected'].includes(parsed.field)) {
        bridge.setReachable(parsed.id, isSensorReachable(sensor)).catch(() => {});
      }
    }
    // Only a label change or a sensor's first reading needs a sync. Value
    // updates must not trigger it, or they'd keep pushing the debounce back.
    const firstValue = !bridged && !hadValue && typeof sensor.value === 'number';
    if (parsed.field === 'CustomName' || parsed.field === typeField || firstValue) {
      scheduleSync(settings);
    }
  }

  function handleVenusValue(settings, topic, value) {
    const sensor = parseSensorTopic(topic);
    if (sensor) {
      handleSensorValue(settings, sensor, value);
      return;
    }

    const bank = parseBankTopic(topic);
    if (bank) {
      if (bank.field === 'CustomName') {
        bankNames[bank.bankKey] = value || undefined;
        scheduleSync(settings); // labels may fall back to the module name
      } else {
        bankConnected[bank.bankKey] = value !== 0 && value !== null;
        refreshReachability();
      }
      return;
    }

    const parsed = parseSwitchTopic(topic);
    if (!parsed) return;

    let circuit = discovered.get(parsed.id);
    if (!circuit) {
      circuit = createCircuit(parsed);
      discovered.set(parsed.id, circuit);
      app.debug(`Discovered output ${parsed.id}`);
    }
    const valueChanged = applyField(circuit, parsed.field, value);

    if (valueChanged && bridge && bridge.has(parsed.id)) {
      const property = parsed.field === 'State' ? 'state' : 'dimming';
      if (circuit[property] !== null && circuit[property] !== undefined) {
        bridge.updateCircuit(parsed.id, property, circuit[property]).catch((err) => {
          app.error(`Failed to update Matter endpoint ${parsed.id}: ${err.message}`);
        });
      }
      if (property === 'state') {
        bridge.setReachable(parsed.id, isReachable(circuit)).catch(() => {});
      }
    } else {
      // Settings (type, name, visibility, ...) or a not-yet-bridged circuit.
      scheduleSync(settings);
    }
  }

  function writeToGx(circuit, field, payload) {
    app.debug(`Matter -> GX: ${circuit.id} ${field} = ${payload}`);
    if (!venus || !venus.write(circuit, field, payload)) {
      app.error(`Cannot write ${circuit.id} ${field}: not connected to the GX`);
      return false;
    }
    return true;
  }

  // A Matter controller changed a circuit: write it straight to the GX.
  function handleMatterCommand(circuit, property, value) {
    if (property === 'dimming') {
      writeToGx(circuit, 'Dimming', value);
      return;
    }
    if (!isMomentary(circuit)) {
      writeToGx(circuit, 'State', value ? 1 : 0);
      return;
    }
    // Momentary: turning it "on" in a Matter app is a short press. Hold the
    // output for MOMENTARY_PULSE_MS, then release it and flip the Matter switch
    // back off. Turning it "off" early releases immediately.
    clearTimeout(momentaryTimers.get(circuit.id));
    momentaryTimers.delete(circuit.id);
    if (!value) {
      writeToGx(circuit, 'State', 0);
      return;
    }
    if (!writeToGx(circuit, 'State', 1)) {
      if (bridge) bridge.updateCircuit(circuit.id, 'state', false).catch(() => {});
      return;
    }
    momentaryTimers.set(
      circuit.id,
      setTimeout(() => {
        momentaryTimers.delete(circuit.id);
        writeToGx(circuit, 'State', 0);
        if (bridge) bridge.updateCircuit(circuit.id, 'state', false).catch(() => {});
      }, MOMENTARY_PULSE_MS),
    );
  }

  plugin.start = async function (settings = {}) {
    stopped = false;
    currentSettings = settings;
    const dataDir = app.getDataDirPath();
    let gx = settings.gxHost && settings.gxHost.trim() ? { host: settings.gxHost.trim(), tls: Boolean(settings.gxTls) } : null;
    gxHostSource = gx ? 'settings' : null;
    if (!gx) {
      gx = detectGxFromVenusPlugin(dataDir);
      if (gx) {
        gxHostSource = 'venus-plugin';
        app.debug(`Using GX address ${gx.host} from the Victron Venus plugin settings`);
      }
    }
    if (!gx) {
      app.setPluginError('Enter the IP address of your GX device (Cerbo GX) in the plugin settings');
      return;
    }

    const identity = loadOrCreateIdentity(dataDir);

    // Required lazily so the plugin module (and its tests) load without
    // pulling in the whole Matter stack.
    const { MatterBridge } = require('./lib/matter-bridge');
    bridge = new MatterBridge({
      storagePath: path.join(dataDir, MATTER_STORAGE_DIR),
      port: settings.port || DEFAULT_PORT,
      passcode: identity.passcode,
      discriminator: identity.discriminator,
      bridgeName: (settings.bridgeName || DEFAULT_BRIDGE_NAME).slice(0, 32),
      uniqueId: identity.uniqueId,
      log: (msg) => app.debug(msg),
      logError: (msg) => app.error(msg),
      onCommand: handleMatterCommand,
    });

    try {
      await bridge.start();
    } catch (err) {
      app.setPluginError(`Failed to start Matter bridge: ${err.message}`);
      bridge = null;
      return;
    }
    if (stopped) {
      // stop() was called while the bridge was starting.
      await bridge.stop();
      bridge = null;
      return;
    }

    const codes = bridge.pairingCodes;
    if (codes && !bridge.isCommissioned) {
      app.debug(`Matter pairing code: ${codes.manualPairingCode} (QR: ${codes.qrPairingCode})`);
    }
    try {
      await restoreCachedCircuits(settings);
    } catch (err) {
      app.error(`Failed to restore cached circuits: ${err.message}`);
    }
    try {
      await restoreCachedSensors(settings);
    } catch (err) {
      app.error(`Failed to restore cached sensors: ${err.message}`);
    }
    updateStatus();

    const { VenusClient } = require('./lib/venus-client');
    venus = new VenusClient({
      host: gx.host,
      port: settings.gxPort || (gx.tls ? DEFAULT_GX_TLS_PORT : DEFAULT_GX_PORT),
      tls: gx.tls,
      username: settings.gxUsername,
      password: settings.gxPassword,
    });
    venus.on('portal', (portalId) => app.debug(`Connected to GX, portal id ${portalId}`));
    venus.on('connect', () => {
      gxConnected = true;
      refreshReachability();
      updateStatus();
    });
    venus.on('offline', () => {
      if (!gxConnected) return;
      gxConnected = false;
      refreshReachability();
      updateStatus();
    });
    venus.on('error', (err) => app.debug(`GX MQTT error: ${err.message}`));
    venus.on('value', (topic, value) => handleVenusValue(settings, topic, value));
    venus.start();
  };

  plugin.stop = async function () {
    stopped = true;
    clearTimeout(settleTimer);
    for (const t of momentaryTimers.values()) clearTimeout(t);
    momentaryTimers.clear();
    for (const { timer } of sensorPushes.values()) clearTimeout(timer);
    sensorPushes.clear();
    gxConnected = false;
    gxHostSource = null;
    if (venus) {
      const v = venus;
      venus = null;
      await v.stop();
    }
    discovered.clear();
    restored.clear();
    lastCacheJson = null;
    discoveredSensors.clear();
    restoredSensors.clear();
    lastSensorCacheJson = null;
    for (const key of Object.keys(bankNames)) delete bankNames[key];
    for (const key of Object.keys(bankConnected)) delete bankConnected[key];
    if (bridge) {
      const b = bridge;
      bridge = null;
      await b.stop();
    }
    app.setPluginStatus('Stopped');
  };

  // Used by the config panel. Admin-only (no router.access()) because the
  // response includes the pairing code, which grants control of every circuit.
  plugin.registerWithRouter = function (router) {
    router.get('/status', async (req, res) => {
      let pairing = null;
      if (bridge && !bridge.isCommissioned && bridge.pairingCodes) {
        const { qrPairingCode, manualPairingCode } = bridge.pairingCodes;
        pairing = {
          qrPairingCode,
          manualPairingCode,
          qrSvg: await QRCode.toString(qrPairingCode, { type: 'svg', margin: 1 }),
        };
      }
      const settings = (app.readPluginOptions && app.readPluginOptions().configuration) || {};
      res.json({
        running: Boolean(bridge),
        gxConnected,
        gxHostSource,
        detectedGxHost: (detectGxFromVenusPlugin(app.getDataDirPath()) || {}).host || null,
        commissioned: bridge ? bridge.isCommissioned : false,
        fabrics: bridge ? bridge.fabrics.map(describeFabric) : [],
        pairing,
        circuits: buildCircuitReport([...discovered.values()], settings.circuits, bankNames, (id) =>
          Boolean(bridge && bridge.has(id)),
        )
          .map((c) => ({ ...c, moduleConnected: bankConnected[c.id.split('.').slice(0, 2).join('.')] !== false }))
          .concat(
            [...restored.values()]
              .filter(({ circuit }) => !discovered.has(circuit.id))
              .map(({ circuit, bankName }) => {
                const o = (settings.circuits || []).find((c) => c && c.id === circuit.id) || {};
                return {
                  ...buildCircuitReport([circuit], settings.circuits, { [bankKeyOf(circuit)]: bankName })[0],
                  bank: bankName || `Switch module ${circuit.instance}`,
                  override: { name: o.name || '', deviceType: o.deviceType || 'auto', enabled: isEnabled(circuit, o) },
                  bridged: Boolean(bridge && bridge.has(circuit.id)),
                  skipReason: null,
                  missing: true,
                };
              }),
          ),
        sensors: buildSensorReport(
          [
            ...discoveredSensors.values(),
            ...[...restoredSensors.values()].filter((s) => !discoveredSensors.has(s.id)),
          ],
          settings,
          (id) => Boolean(bridge && bridge.has(id)),
        ).map((s) => (discoveredSensors.has(s.id) ? s : { ...s, skipReason: null, missing: true })),
      });
    });

    // Forget every pairing and start over with a fresh bridge identity, so the
    // QR code is shown again. Needed when a controller removed the bridge
    // without telling it (or the bridge was never removed from the app).
    router.post('/reset-pairing', async (req, res) => {
      try {
        app.debug('Resetting Matter pairing');
        const settings = currentSettings;
        const wasRunning = !stopped;
        await plugin.stop();
        const dataDir = app.getDataDirPath();
        fs.rmSync(path.join(dataDir, MATTER_STORAGE_DIR), { recursive: true, force: true });
        fs.rmSync(path.join(dataDir, IDENTITY_FILE), { force: true });
        fs.rmSync(path.join(dataDir, CIRCUIT_CACHE_FILE), { force: true });
        fs.rmSync(path.join(dataDir, SENSOR_CACHE_FILE), { force: true });
        if (wasRunning) await plugin.start(settings);
        res.json({ ok: true });
      } catch (err) {
        app.error(`Failed to reset pairing: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  };

  plugin.schema = () => ({
    type: 'object',
    properties: {
      gxHost: {
        type: 'string',
        title: 'GX device IP address',
        description:
          'IP address or hostname of your Cerbo GX / Venus OS device. MQTT access must be enabled on the GX. Leave blank to use the address from the Victron Venus plugin, if installed.',
      },
      gxPort: {
        type: 'number',
        title: 'GX MQTT port',
        description: 'Leave blank for the default (1883, or 8883 with TLS).',
      },
      gxTls: {
        type: 'boolean',
        title: 'Use TLS',
        description: 'Enable if the GX security profile only allows encrypted MQTT (port 8883).',
        default: false,
      },
      gxUsername: {
        type: 'string',
        title: 'GX MQTT username',
        description: 'Only needed if the GX security profile requires a password.',
      },
      gxPassword: {
        type: 'string',
        title: 'GX MQTT password',
        description: 'The GX device password, if the security profile requires one.',
      },
      bridgeName: {
        type: 'string',
        title: 'Bridge name',
        description: 'Name shown in the Home app / Google Home when pairing (max 32 characters).',
        default: DEFAULT_BRIDGE_NAME,
      },
      port: {
        type: 'number',
        title: 'Matter port',
        description: 'UDP port the Matter bridge listens on.',
        default: DEFAULT_PORT,
      },
      circuits: {
        type: 'array',
        title: 'Circuit overrides',
        description: 'Per-circuit settings, edited in the plugin configuration panel.',
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', title: 'Circuit id (e.g. "switch.0.6")' },
            name: { type: 'string', title: 'Display name' },
            deviceType: {
              type: 'string',
              title: 'Matter device type',
              enum: DEVICE_TYPES,
              enumNames: ['Auto-detect', 'On/off light', 'Dimmable light', 'Outlet / pump'],
              default: 'auto',
            },
            enabled: { type: 'boolean', title: 'Expose to Matter', default: true },
          },
        },
      },
      tanks: {
        type: 'array',
        title: 'Tank overrides',
        description: 'Per-tank settings, edited in the plugin configuration panel.',
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', title: 'Tank id (e.g. "tank.20")' },
            name: { type: 'string', title: 'Display name' },
            enabled: { type: 'boolean', title: 'Expose to Matter', default: true },
          },
        },
      },
      temperatures: {
        type: 'array',
        title: 'Temperature sensor overrides',
        description: 'Per-sensor settings, edited in the plugin configuration panel.',
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', title: 'Sensor id (e.g. "temperature.24")' },
            name: { type: 'string', title: 'Display name' },
            enabled: { type: 'boolean', title: 'Expose to Matter', default: true },
          },
        },
      },
    },
  });

  return plugin;
};

module.exports.internal = {
  describeFabric,
  detectGxFromVenusPlugin,
  loadCircuitCache,
  loadSensorCache,
  isValidPasscode,
  randomPasscode,
  loadOrCreateIdentity,
};
