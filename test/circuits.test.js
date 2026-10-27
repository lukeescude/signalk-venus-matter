// Tests for the pure circuit helpers: Venus MQTT topic parsing, building the
// circuit model, value conversion, and merging discovered circuits with user config.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSwitchTopic,
  parseBankTopic,
  statusFaults,
  isEnabled,
  createCircuit,
  applyField,
  isBridgeable,
  circuitLabel,
  resolveDeviceType,
  buildBridgedCircuits,
  buildCircuitReport,
  percentToMatterLevel,
  matterLevelToPercent,
  endpointIdFor,
  toCacheEntry,
  fromCacheEntry,
} = require('../lib/circuits');

function circuit(fields, id = 'switch.0.6') {
  const [service, instance, channel] = id.split('.');
  const c = createCircuit({ id, service, instance, channel });
  for (const [field, value] of Object.entries(fields)) applyField(c, field, value);
  return c;
}

test('parseSwitchTopic parses switch module and GX relay topics', () => {
  assert.deepEqual(parseSwitchTopic('N/c0619ab722af/switch/0/SwitchableOutput/6/State'), {
    portalId: 'c0619ab722af',
    service: 'switch',
    instance: '0',
    channel: '6',
    field: 'State',
    id: 'switch.0.6',
  });
  assert.equal(parseSwitchTopic('N/abc/switch/1/SwitchableOutput/11/Settings/CustomName').field, 'Settings/CustomName');
  assert.equal(parseSwitchTopic('N/abc/system/0/SwitchableOutput/0/State').id, 'system.0.0');
});

test('parseSwitchTopic ignores unrelated topics', () => {
  assert.equal(parseSwitchTopic('N/abc/switch/0/CustomName'), null);
  assert.equal(parseSwitchTopic('N/abc/battery/0/Dc/0/Voltage'), null);
  assert.equal(parseSwitchTopic('W/abc/switch/0/SwitchableOutput/6/State'), null);
});

test('parseBankTopic reads switch module names and connection state', () => {
  assert.deepEqual(parseBankTopic('N/abc/switch/1/CustomName'), {
    portalId: 'abc',
    bankKey: 'switch.1',
    field: 'CustomName',
  });
  assert.equal(parseBankTopic('N/abc/switch/1/Connected').field, 'Connected');
  assert.equal(parseBankTopic('N/abc/switch/1/SwitchableOutput/0/Settings/CustomName'), null);
  assert.equal(parseBankTopic('N/abc/switch/1/ProductName'), null);
});

test('statusFaults reports fault bits but not normal on/powered bits', () => {
  assert.deepEqual(statusFaults(0), []);
  assert.deepEqual(statusFaults(9), []); // normal "on"
  assert.deepEqual(statusFaults(0x02 | 0x09), ['Tripped']);
  assert.deepEqual(statusFaults(0x04 | 0x10 | 0x20), ['Over temperature', 'Short circuit', 'Disabled']);
  assert.deepEqual(statusFaults(undefined), []);
});

test('applyField updates the model and reports value changes', () => {
  const c = createCircuit({ id: 'switch.0.6', service: 'switch', instance: '0', channel: '6' });
  assert.equal(applyField(c, 'State', 1), true);
  assert.equal(c.state, true);
  assert.equal(applyField(c, 'Dimming', 55), true);
  assert.equal(c.dimming, 55);
  assert.equal(applyField(c, 'Settings/Type', 2), false);
  assert.equal(c.type, 2);
  assert.equal(applyField(c, 'Settings/CustomName', ''), false);
  assert.equal(c.customName, undefined);
  assert.equal(applyField(c, 'State', null), true);
  assert.equal(c.state, null);
});

test('isBridgeable accepts controllable momentary, toggle, and dimmable outputs', () => {
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 1, 'State': 0 })), true);
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 2, 'State': 1 })), true);
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 0, 'State': 0 })), true);
  // Slider, dropdown, etc. are not supported yet.
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 7, 'State': 0 })), false);
  // Type not received yet.
  assert.equal(isBridgeable(circuit({ State: 0 })), false);
  // GX relay assigned to another function.
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 1, 'State': null })), false);
  // ...but an already-bridged circuit whose State went null is kept (shown unreachable).
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 1, 'State': null }), true), true);
  // Hiding it on the GX removes it even if it was bridged.
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 1, 'State': 0, 'Settings/ShowUIControl': 0 }), true), false);
  // Hidden in all Victron UIs / not controllable.
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 1, 'State': 0, 'Settings/ShowUIControl': 0 })), false);
  assert.equal(isBridgeable(circuit({ 'Settings/Type': 1, 'State': 0, 'Settings/ValidTypes': 0 })), false);
});

test('circuitLabel prefers CustomName, then Name, then bank + channel', () => {
  assert.equal(circuitLabel(circuit({ 'Name': 'Channel 7', 'Settings/CustomName': 'Saloon Lights' })), 'Saloon Lights');
  assert.equal(circuitLabel(circuit({ Name: 'Channel 7' })), 'Channel 7');
  assert.equal(circuitLabel(circuit({}), { 'switch.0': 'Port Elec 1' }), 'Port Elec 1 6');
});

test('resolveDeviceType follows the Victron type, name, and overrides', () => {
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 2 }), undefined, 'Saloon Lights'), 'dimmableLight');
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 1 }), undefined, 'Port Nav Light'), 'light');
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 1 }), undefined, 'Port Engine Bilge Pump'), 'outlet');
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 1 }), undefined, 'Front Galley Freezer'), 'outlet');
  assert.equal(
    resolveDeviceType(circuit({ 'Settings/Type': 1, 'Settings/Group': 'Exterior Lighting' }), undefined, 'Spreaders'),
    'light',
  );
  // The circuit's name beats a location-based group.
  assert.equal(
    resolveDeviceType(circuit({ 'Settings/Type': 1, 'Settings/Group': 'Port Hull Lighting' }), undefined, 'Port Fans'),
    'outlet',
  );
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 1 }), undefined, 'TV Amplifier'), 'outlet');
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 1 }), undefined, 'Chart Table B&G'), 'outlet');
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 2 }), 'outlet', 'Saloon Lights'), 'outlet');
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 1 }), 'bogus', 'Fridge'), 'outlet');
  // A non-dimmable output can't be forced into a dimmable light.
  assert.equal(resolveDeviceType(circuit({ 'Settings/Type': 1 }), 'dimmableLight', 'Fridge'), 'light');
});

test('buildBridgedCircuits applies names, types, and disables', () => {
  const discovered = [
    circuit({ 'Settings/Type': 2, 'State': 1, 'Settings/CustomName': 'Saloon Lights' }, 'switch.0.7'),
    circuit({ 'Settings/Type': 1, 'State': 0, 'Settings/CustomName': 'Bilge Pump' }, 'switch.0.5'),
    circuit({ 'Settings/Type': 1, 'State': 0, 'Settings/CustomName': 'Spare' }, 'switch.1.5'),
    circuit({ 'Settings/Type': 1, 'State': null }, 'system.0.0'),
  ];
  const result = buildBridgedCircuits(discovered, [
    { id: 'switch.1.5', enabled: false },
    { id: 'switch.0.5', deviceType: 'light' },
    { id: 'switch.0.7', name: '  Saloon  ' },
  ]);
  assert.deepEqual(
    result.map((c) => [c.id, c.label, c.deviceType]),
    [
      ['switch.0.7', 'Saloon', 'dimmableLight'],
      ['switch.0.5', 'Bilge Pump', 'light'],
    ],
  );
});

test('percent <-> Matter level conversion clamps and round-trips', () => {
  assert.equal(percentToMatterLevel(100), 254);
  assert.equal(percentToMatterLevel(0), 1);
  assert.equal(percentToMatterLevel(50), 127);
  assert.equal(percentToMatterLevel(150), 254);
  assert.equal(matterLevelToPercent(254), 100);
  assert.equal(matterLevelToPercent(127), 50);
  assert.equal(matterLevelToPercent(0), 0);
  // Every GX percentage must survive a round trip, or echo suppression breaks.
  for (let p = 1; p <= 100; p++) {
    assert.equal(matterLevelToPercent(percentToMatterLevel(p)), p, `round trip of ${p}%`);
  }
});

test('endpointIdFor produces stable, dot-free ids', () => {
  assert.equal(endpointIdFor('switch.0.6'), 'circuit-switch-0-6');
});

test('buildCircuitReport lists every output with auto values, overrides, and skip reasons', () => {
  const discovered = [
    circuit({ 'Settings/Type': 1, 'State': 0, 'Settings/CustomName': 'Bilge Pump' }, 'switch.0.10'),
    circuit({ 'Settings/Type': 2, 'State': 1, 'Settings/CustomName': 'Saloon Lights' }, 'switch.0.7'),
    circuit({ 'Settings/Type': 1, 'State': 0, 'Settings/ShowUIControl': 0, 'Name': 'Channel 6' }, 'switch.1.5'),
  ];
  const report = buildCircuitReport(
    discovered,
    [{ id: 'switch.0.10', deviceType: 'light', name: 'Bilge' }],
    { 'switch.0': 'Port Elec 1', 'switch.1': 'Port Elec 2' },
    (id) => id === 'switch.0.7',
  );
  // Sorted by bank, then numerically by channel.
  assert.deepEqual(
    report.map((c) => c.id),
    ['switch.0.7', 'switch.0.10', 'switch.1.5'],
  );
  const [saloon, bilge, hidden] = report;
  assert.equal(saloon.autoDeviceType, 'dimmableLight');
  assert.equal(saloon.dimmable, true);
  assert.equal(saloon.bridged, true);
  assert.deepEqual(saloon.override, { name: '', deviceType: 'auto', enabled: true });
  assert.equal(bilge.bank, 'Port Elec 1');
  assert.equal(bilge.autoDeviceType, 'outlet');
  assert.deepEqual(bilge.override, { name: 'Bilge', deviceType: 'light', enabled: true });
  assert.equal(hidden.skipReason, 'Hidden in the Victron UI');
  assert.equal(saloon.skipReason, null);
});

test('momentary outputs are opt-in, everything else opt-out', () => {
  const momentary = circuit({ 'Settings/Type': 0, 'State': 0, 'Settings/CustomName': 'Horn' }, 'switch.0.3');
  const toggle = circuit({ 'Settings/Type': 1, 'State': 0, 'Settings/CustomName': 'Pump' }, 'switch.0.4');
  assert.equal(isEnabled(momentary, undefined), false);
  assert.equal(isEnabled(momentary, { enabled: true }), true);
  assert.equal(isEnabled(toggle, {}), true);
  assert.equal(isEnabled(toggle, { enabled: false }), false);

  assert.deepEqual(
    buildBridgedCircuits([momentary, toggle]).map((c) => c.id),
    ['switch.0.4'],
  );
  assert.deepEqual(
    buildBridgedCircuits([momentary, toggle], [{ id: 'switch.0.3', enabled: true }]).map((c) => [c.id, c.deviceType]),
    [
      ['switch.0.3', 'outlet'],
      ['switch.0.4', 'outlet'],
    ],
  );
  const [report] = buildCircuitReport([momentary]);
  assert.equal(report.momentary, true);
  assert.equal(report.override.enabled, false);
});

test('buildBridgedCircuits keeps bridged circuits whose state went null', () => {
  const offline = circuit({ 'Settings/Type': 1, 'State': null, 'Settings/CustomName': 'Pump' }, 'switch.0.4');
  assert.deepEqual(buildBridgedCircuits([offline]), []);
  assert.equal(buildBridgedCircuits([offline], [], {}, () => true).length, 1);
});

test('cache entries round-trip the fields that drive label and device type, not state', () => {
  const original = circuit(
    { 'Settings/Type': 2, 'State': 1, 'Dimming': 40, 'Settings/CustomName': 'Saloon Lights', 'Settings/Group': 'Saloon' },
    'switch.0.7',
  );
  const entry = toCacheEntry(original, { 'switch.0': 'Port Elec 1' });
  assert.equal(entry.state, undefined);
  assert.equal(entry.dimming, undefined);
  assert.equal(entry.bankName, 'Port Elec 1');

  const { circuit: restored, bankName } = JSON.parse(JSON.stringify([entry])).map(fromCacheEntry)[0];
  assert.equal(bankName, 'Port Elec 1');
  assert.equal(restored.state, undefined);
  const [bridged] = buildBridgedCircuits([restored], [], {}, () => true);
  assert.equal(bridged.label, 'Saloon Lights');
  assert.equal(bridged.deviceType, 'dimmableLight');
});

test('fromCacheEntry rejects malformed entries', () => {
  assert.equal(fromCacheEntry(null), null);
  assert.equal(fromCacheEntry({ id: 'switch.0.1' }), null);
  assert.equal(fromCacheEntry({ service: 'switch', instance: '0', channel: '1' }), null);
});
