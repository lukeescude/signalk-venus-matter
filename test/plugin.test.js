// Tests for the Signal K plugin surface: the factory export, the object it
// returns, and the configuration schema the admin UI renders from.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const plugin = require('../index.js');

function mockApp() {
  return {
    config: { settings: {} },
    debug() {},
    error() {},
    setPluginStatus() {},
    setPluginError() {},
    handleMessage() {},
  };
}

test('module exports a plugin factory and internal helpers', () => {
  assert.equal(typeof plugin, 'function');
  for (const name of ['isValidPasscode', 'randomPasscode', 'loadOrCreateIdentity']) {
    assert.equal(typeof plugin.internal[name], 'function', `internal.${name} should be a function`);
  }
});

test('factory returns a Signal K plugin object', () => {
  const p = plugin(mockApp());
  assert.equal(p.id, 'signalk-venus-matter');
  assert.equal(typeof p.name, 'string');
  assert.equal(typeof p.start, 'function');
  assert.equal(typeof p.stop, 'function');
  assert.equal(typeof p.registerWithRouter, 'function');
  const schema = p.schema();
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties.port);
  assert.ok(schema.properties.circuits.items.properties.deviceType.enum.includes('auto'));
});

function tmpPluginDataDir() {
  // Mirrors ~/.signalk/plugin-config-data/<plugin id>
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-venus-matter-'));
  const dataDir = path.join(root, 'signalk-venus-matter');
  fs.mkdirSync(dataDir);
  return { root, dataDir };
}

test('start without a GX host (and no Venus plugin config) reports a configuration error', async () => {
  const { root, dataDir } = tmpPluginDataDir();
  try {
    let error;
    const p = plugin({ ...mockApp(), getDataDirPath: () => dataDir, setPluginError: (msg) => (error = msg) });
    await p.start({});
    assert.match(error, /IP address of your GX/);
    await p.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detectGxFromVenusPlugin reads the Venus plugin connection settings', () => {
  const { detectGxFromVenusPlugin } = plugin.internal;
  const { root, dataDir } = tmpPluginDataDir();
  const writeVenus = (configuration) =>
    fs.writeFileSync(path.join(root, 'venus.json'), JSON.stringify({ enabled: true, configuration }));
  try {
    assert.equal(detectGxFromVenusPlugin(dataDir), null);
    writeVenus({ installType: 'mqtt', MQTT: { host: '192.168.1.50' } });
    assert.deepEqual(detectGxFromVenusPlugin(dataDir), { host: '192.168.1.50', tls: false });
    writeVenus({ installType: 'mqtts', MQTT: { host: 'cerbo.local' } });
    assert.deepEqual(detectGxFromVenusPlugin(dataDir), { host: 'cerbo.local', tls: true });
    writeVenus({ installType: 'local' });
    assert.deepEqual(detectGxFromVenusPlugin(dataDir), { host: '127.0.0.1', tls: false });
    writeVenus({ installType: 'remote', dbusAddress: 'tcp:host=192.168.1.60,port=78' });
    assert.deepEqual(detectGxFromVenusPlugin(dataDir), { host: '192.168.1.60', tls: false });
    writeVenus({ installType: 'vrm' });
    assert.equal(detectGxFromVenusPlugin(dataDir), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isValidPasscode rejects spec-forbidden and out-of-range values', () => {
  const { isValidPasscode } = plugin.internal;
  assert.equal(isValidPasscode(20202021), true);
  assert.equal(isValidPasscode(12345678), false);
  assert.equal(isValidPasscode(11111111), false);
  assert.equal(isValidPasscode(0), false);
  assert.equal(isValidPasscode(99999999), false);
  assert.equal(isValidPasscode('20202021'), false);
});

test('randomPasscode always produces a valid passcode', () => {
  const { isValidPasscode, randomPasscode } = plugin.internal;
  for (let i = 0; i < 100; i++) {
    assert.equal(isValidPasscode(randomPasscode()), true);
  }
});

test('loadOrCreateIdentity persists and reuses the bridge identity', () => {
  const { loadOrCreateIdentity } = plugin.internal;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-venus-matter-'));
  try {
    const first = loadOrCreateIdentity(dir);
    assert.match(first.uniqueId, /^[0-9a-f]{16}$/);
    assert.ok(first.discriminator >= 0 && first.discriminator <= 4095);
    assert.deepEqual(loadOrCreateIdentity(dir), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('describeFabric names known controller ecosystems', () => {
  const { describeFabric } = plugin.internal;
  assert.deepEqual(describeFabric({ fabricIndex: 1, vendorId: 0x1349, label: 'S/V Example' }), {
    fabricIndex: 1,
    vendorId: 0x1349,
    vendor: 'Apple Home',
    label: 'S/V Example',
  });
  assert.equal(describeFabric({ fabricIndex: 2, vendorId: 0x6006 }).vendor, 'Google Home');
  assert.equal(describeFabric({ fabricIndex: 3, vendorId: 0xabc }).vendor, 'Vendor 0x0abc');
});
