// Thin wrapper around matter.js that runs a single Matter bridge (an Aggregator
// endpoint) with one bridged endpoint per Victron circuit. The plugin talks to
// this through add/update/remove calls and receives controller-initiated changes
// through the onCommand callback, so index.js never touches matter.js directly.
const { Endpoint, Environment, Logger, LogFormat, LogLevel, ServerNode, VendorId } = require('@matter/main');
const { BridgedDeviceBasicInformationServer } = require('@matter/main/behaviors');
const { AggregatorEndpoint } = require('@matter/main/endpoints');
const {
  DimmableLightDevice,
  OnOffLightDevice,
  OnOffPlugInUnitDevice,
} = require('@matter/main/devices');

const { endpointIdFor, percentToMatterLevel, matterLevelToPercent } = require('./circuits');

// 0xFFF1 is the CSA test vendor id. Fine for an uncertified bridge; controllers
// will warn the device is "uncertified" during pairing.
const TEST_VENDOR_ID = 0xfff1;
const PRODUCT_ID = 0x8000;

const DEVICE_CLASSES = {
  light: OnOffLightDevice,
  dimmableLight: DimmableLightDevice,
  outlet: OnOffPlugInUnitDevice,
};

// matter.js logs to stdout by default (including a terminal QR code). Send it to
// the Signal K plugin log instead: errors always, everything else only when the
// plugin's debug logging is switched on. Logger is process-global.
function routeMatterLogging({ debug, error }) {
  Logger.format = LogFormat.PLAIN;
  Logger.level = LogLevel.INFO;
  Logger.destinations.default.write = (text, message) => {
    const line = `matter.js: ${text}`;
    if (message.level >= LogLevel.ERROR) error(line);
    else debug(line);
  };
}

class MatterBridge {
  constructor({ storagePath, port, passcode, discriminator, bridgeName, uniqueId, log, logError, onCommand }) {
    this.options = { storagePath, port, passcode, discriminator, bridgeName, uniqueId };
    this.log = log || (() => {});
    this.logError = logError || this.log;
    this.onCommand = onCommand || (() => {});
    this.server = null;
    this.aggregator = null;
    // circuit id -> { endpoint, circuit }
    this.endpoints = new Map();
  }

  async start() {
    const { storagePath, port, passcode, discriminator, bridgeName, uniqueId } = this.options;
    routeMatterLogging({ debug: this.log, error: this.logError });

    // Persist fabrics/commissioning state in the plugin's data dir so pairings
    // survive restarts and plugin upgrades.
    Environment.default.vars.set('storage.path', storagePath);

    // The node id names the storage subdirectory holding fabrics/pairings, and the
    // serial number is part of the identity controllers saw at pairing time. Both
    // predate the package rename to signalk-venus-matter; keep them unchanged so
    // existing pairings survive.
    this.server = await ServerNode.create({
      id: 'signalk-matter',
      network: { port },
      commissioning: { passcode, discriminator },
      productDescription: {
        name: bridgeName,
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorName: 'Signal K',
        vendorId: VendorId(TEST_VENDOR_ID),
        nodeLabel: bridgeName,
        productName: 'Signal K Matter Bridge',
        productLabel: 'Victron Switching Bridge',
        productId: PRODUCT_ID,
        serialNumber: `signalk-matter-${uniqueId}`,
        uniqueId,
      },
    });

    this.aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await this.server.add(this.aggregator);
    await this.server.start();
  }

  async stop() {
    if (this.server) {
      await this.server.close();
    }
    this.server = null;
    this.aggregator = null;
    this.endpoints.clear();
  }

  get isCommissioned() {
    return Boolean(this.server && this.server.lifecycle.isCommissioned);
  }

  get pairingCodes() {
    if (!this.server) return null;
    const { qrPairingCode, manualPairingCode } = this.server.state.commissioning.pairingCodes;
    return { qrPairingCode, manualPairingCode };
  }

  // Controllers (fabrics) this bridge is paired with. Apple Home adds two: the
  // Home fabric (labelled with the home's name) and an Apple companion fabric.
  get fabrics() {
    if (!this.server) return [];
    return Object.values(this.server.state.commissioning.fabrics).map((f) => ({
      fabricIndex: f.fabricIndex,
      vendorId: f.rootVendorId,
      label: f.label,
    }));
  }

  has(circuitId) {
    return this.endpoints.has(circuitId);
  }

  async addCircuit(circuit, reachable = true) {
    if (this.endpoints.has(circuit.id)) return;
    const DeviceClass = DEVICE_CLASSES[circuit.deviceType] || OnOffLightDevice;
    const label = circuit.label.slice(0, 32); // nodeLabel max length

    const initial = {
      id: endpointIdFor(circuit.id),
      bridgedDeviceBasicInformation: {
        nodeLabel: label,
        productName: label,
        productLabel: label,
        serialNumber: circuit.id.slice(0, 32),
        reachable,
      },
      onOff: { onOff: Boolean(circuit.state) },
    };
    if (circuit.deviceType === 'dimmableLight' && typeof circuit.dimming === 'number') {
      initial.levelControl = { currentLevel: percentToMatterLevel(circuit.dimming) };
    }

    const endpoint = new Endpoint(DeviceClass.with(BridgedDeviceBasicInformationServer), initial);
    await this.aggregator.add(endpoint);

    const entry = { endpoint, circuit: { ...circuit }, reachable };
    this.endpoints.set(circuit.id, entry);

    // Changes coming from a Matter controller (phone, hub). Values that we set
    // ourselves from the GX are filtered out by comparing to the last known GX
    // value, so updates don't echo back as writes.
    endpoint.events.onOff.onOff$Changed.on((value) => {
      if (value === Boolean(entry.circuit.state)) return;
      entry.circuit.state = value;
      this.onCommand(entry.circuit, 'state', value);
    });
    if (circuit.deviceType === 'dimmableLight') {
      endpoint.events.levelControl.currentLevel$Changed.on((level) => {
        if (level === null) return;
        const percent = matterLevelToPercent(level);
        if (percent === entry.circuit.dimming) return;
        entry.circuit.dimming = percent;
        this.onCommand(entry.circuit, 'dimming', percent);
      });
    }

    this.log(`Bridged ${circuit.id} as ${circuit.deviceType} "${label}"`);
  }

  // Push a value change from the GX to the Matter endpoint.
  async updateCircuit(circuitId, property, value) {
    const entry = this.endpoints.get(circuitId);
    if (!entry) return;
    if (property === 'state') {
      entry.circuit.state = Boolean(value);
      await entry.endpoint.set({ onOff: { onOff: Boolean(value) } });
    } else if (property === 'dimming' && entry.circuit.deviceType === 'dimmableLight') {
      if (typeof value !== 'number') return;
      entry.circuit.dimming = value;
      await entry.endpoint.set({ levelControl: { currentLevel: percentToMatterLevel(value) } });
    }
  }

  // Mark a bridged device reachable/unreachable (GX connection down, module
  // offline, ...) so controllers show "No Response" instead of stale state.
  async setReachable(circuitId, reachable) {
    const entry = this.endpoints.get(circuitId);
    if (!entry || entry.reachable === reachable) return;
    entry.reachable = reachable;
    await entry.endpoint.set({ bridgedDeviceBasicInformation: { reachable } });
  }

  // Rename in place, keeping the endpoint (and so the accessory's room and
  // automations in Home apps). Apps that already named the accessory may keep
  // their own name.
  async updateLabel(circuitId, label) {
    const entry = this.endpoints.get(circuitId);
    if (!entry || entry.circuit.label === label) return;
    entry.circuit.label = label;
    await entry.endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: label.slice(0, 32) } });
  }

  // The bridged circuit (label, device type, last known values), or undefined.
  get(circuitId) {
    const entry = this.endpoints.get(circuitId);
    return entry && entry.circuit;
  }

  async removeCircuit(circuitId) {
    const entry = this.endpoints.get(circuitId);
    if (!entry) return;
    this.endpoints.delete(circuitId);
    await entry.endpoint.close();
  }
}

module.exports = { MatterBridge };
