// Tests for the pure sensor helpers (tanks and temperature probes): Venus MQTT
// topic parsing, the sensor model, labels, the Matter value mapping, and merging
// discovered sensors with user config.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  sensorTopics,
  parseSensorTopic,
  createSensor,
  applySensorField,
  sensorLabel,
  sensorFault,
  buildBridgedSensors,
  buildSensorReport,
  toSensorCacheEntry,
  fromSensorCacheEntry,
  levelToHumidity,
  celsiusToMatter,
  toMatterValue,
  sensorEndpointIdFor,
} = require('../lib/sensors');

function sensor(fields, id = 'tank.20') {
  const [kind, instance] = id.split('.');
  const s = createSensor({ id, kind, instance });
  for (const [field, value] of Object.entries(fields)) applySensorField(s, field, value);
  return s;
}

test('sensorTopics subscribes to the listed fields of every kind', () => {
  const topics = sensorTopics('abc');
  assert.ok(topics.includes('N/abc/tank/+/Level'));
  assert.ok(topics.includes('N/abc/tank/+/Remaining'));
  assert.ok(topics.includes('N/abc/temperature/+/Temperature'));
  assert.ok(topics.includes('N/abc/temperature/+/TemperatureType'));
  assert.ok(!topics.includes('N/abc/temperature/+/Remaining'));
  assert.ok(topics.every((t) => !t.includes('#')));
});

test('parseSensorTopic parses tank and temperature fields only', () => {
  assert.deepEqual(parseSensorTopic('N/c0619ab722af/tank/20/Level'), {
    portalId: 'c0619ab722af',
    kind: 'tank',
    instance: '20',
    field: 'Level',
    id: 'tank.20',
  });
  assert.equal(parseSensorTopic('N/abc/temperature/24/Temperature').id, 'temperature.24');
  assert.equal(parseSensorTopic('N/abc/temperature/24/TemperatureType').field, 'TemperatureType');
  assert.equal(parseSensorTopic('N/abc/tank/3/RawValue'), null);
  assert.equal(parseSensorTopic('N/abc/temperature/3/Level'), null);
  assert.equal(parseSensorTopic('N/abc/tank/3/Alarms/High/State'), null);
  assert.equal(parseSensorTopic('N/abc/switch/0/CustomName'), null);
  assert.equal(parseSensorTopic('N/abc/battery/0/Soc'), null);
});

test('applySensorField updates the model and reports value changes only', () => {
  const t = createSensor({ id: 'tank.1', kind: 'tank', instance: '1' });
  assert.equal(applySensorField(t, 'Level', 42.5), true);
  assert.equal(applySensorField(t, 'Level', 42.5), false);
  assert.equal(applySensorField(t, 'Level', null), true);
  assert.equal(t.value, undefined);
  assert.equal(applySensorField(t, 'FluidType', 5), false);
  assert.equal(t.sensorType, 5);
  applySensorField(t, 'Connected', 0);
  assert.equal(t.connected, false);
  applySensorField(t, 'CustomName', '');
  assert.equal(t.customName, undefined);

  const f = createSensor({ id: 'temperature.24', kind: 'temperature', instance: '24' });
  assert.equal(applySensorField(f, 'Temperature', -18.2), true);
  assert.equal(f.value, -18.2);
  // Another kind's value field is ignored.
  assert.equal(applySensorField(f, 'Level', 50), false);
  assert.equal(f.value, -18.2);
  applySensorField(f, 'TemperatureType', 6);
  assert.equal(f.sensorType, 6);
});

test('sensorLabel prefers CustomName, then the fluid or temperature type', () => {
  assert.equal(sensorLabel(sensor({ CustomName: 'Holding', FluidType: 5 })), 'Holding');
  assert.equal(sensorLabel(sensor({ FluidType: 5 })), 'Black water tank');
  assert.equal(sensorLabel(sensor({ FluidType: 7 })), 'Diesel tank');
  assert.equal(sensorLabel(sensor({})), 'Tank 20');
  assert.equal(sensorLabel(sensor({ TemperatureType: 1 }, 'temperature.24')), 'Fridge');
  assert.equal(sensorLabel(sensor({ TemperatureType: 6 }, 'temperature.24')), 'Freezer');
  assert.equal(sensorLabel(sensor({ TemperatureType: 4 }, 'temperature.24')), 'Outdoor temperature');
  assert.equal(sensorLabel(sensor({ CustomName: 'Wine fridge', TemperatureType: 1 }, 'temperature.24')), 'Wine fridge');
  assert.equal(sensorLabel(sensor({}, 'temperature.24')), 'Temperature 24');
});

test('sensorFault reports offline sensors and sensor faults', () => {
  assert.equal(sensorFault(sensor({ Status: 0 })), null);
  assert.equal(sensorFault(sensor({ Status: 1 })), 'Sensor disconnected');
  assert.equal(sensorFault(sensor({ Status: 0, Connected: 0 })), 'Sensor offline');
});

test('levelToHumidity rounds to whole percent in 0.01 % units and clamps', () => {
  assert.equal(levelToHumidity(0), 0);
  assert.equal(levelToHumidity(42.4), 4200);
  assert.equal(levelToHumidity(42.6), 4300);
  assert.equal(levelToHumidity(100), 10000);
  assert.equal(levelToHumidity(104), 10000);
  assert.equal(levelToHumidity(-3), 0);
  assert.equal(levelToHumidity(undefined), null);
  assert.equal(levelToHumidity(NaN), null);
});

test('celsiusToMatter rounds to 0.1 °C in 0.01 °C units and stays in int16', () => {
  assert.equal(celsiusToMatter(3.14), 310);
  assert.equal(celsiusToMatter(3.16), 320);
  assert.equal(celsiusToMatter(-18.24), -1820);
  assert.equal(celsiusToMatter(0), 0);
  assert.equal(celsiusToMatter(500), 32767);
  assert.equal(celsiusToMatter(-300), -27315);
  assert.equal(celsiusToMatter(null), null);
  assert.equal(toMatterValue('temperature', 4), 400);
  assert.equal(toMatterValue('tank', 55), 5500);
});

test('buildBridgedSensors needs a value, applies names, and honours disables per kind', () => {
  const fresh = sensor({ Level: 80, FluidType: 1 }, 'tank.1');
  const black = sensor({ Level: 30, FluidType: 5 }, 'tank.2');
  const noLevel = sensor({ FluidType: 7 }, 'tank.3');
  const freezer = sensor({ Temperature: -18, TemperatureType: 6 }, 'temperature.1');
  const result = buildBridgedSensors([fresh, black, noLevel, freezer], {
    tanks: [
      { id: 'tank.1', name: 'Forward water' },
      { id: 'tank.2', enabled: false },
    ],
    temperatures: [{ id: 'temperature.1', name: 'Deep freeze' }],
  });
  assert.deepEqual(
    result.map((s) => [s.id, s.label]),
    [
      ['tank.1', 'Forward water'],
      ['temperature.1', 'Deep freeze'],
    ],
  );
  // Already bridged sensors are kept when their value goes away.
  assert.equal(buildBridgedSensors([noLevel], {}, () => true).length, 1);
});

test('same-typed sensors without a custom name get their instance appended', () => {
  const fridges = [
    sensor({ Temperature: 4, TemperatureType: 1 }, 'temperature.24'),
    sensor({ Temperature: 5, TemperatureType: 1 }, 'temperature.25'),
    sensor({ Temperature: 3, TemperatureType: 1, CustomName: 'Fridge' }, 'temperature.26'),
    sensor({ Temperature: -18, TemperatureType: 6 }, 'temperature.27'),
  ];
  assert.deepEqual(
    buildBridgedSensors(fridges).map((s) => s.label),
    ['Fridge 24', 'Fridge 25', 'Fridge', 'Freezer'],
  );
});

test('buildSensorReport lists sensors by kind with volumes in litres and skip reasons', () => {
  const report = buildSensorReport(
    [
      sensor({ Temperature: 4.2, TemperatureType: 1 }, 'temperature.24'),
      sensor({ Level: 50, FluidType: 7, Capacity: 0.2, Remaining: 0.1 }, 'tank.10'),
      sensor({}, 'tank.2'),
    ],
    { tanks: [{ id: 'tank.10', name: 'Main fuel' }] },
    (id) => id === 'tank.10',
  );
  assert.deepEqual(
    report.map((s) => s.id),
    ['tank.2', 'tank.10', 'temperature.24'],
  );
  assert.equal(report[0].skipReason, 'Waiting for a reading');
  assert.equal(report[1].typeName, 'Diesel');
  assert.equal(report[1].capacityLitres, 200);
  assert.equal(report[1].remainingLitres, 100);
  assert.deepEqual(report[1].override, { name: 'Main fuel', enabled: true });
  assert.equal(report[1].bridged, true);
  assert.equal(report[2].typeName, 'Fridge');
  assert.equal(report[2].value, 4.2);
  assert.equal(report[2].capacityLitres, null);
});

test('sensor cache entries keep label fields, not the value', () => {
  const t = sensor({ Level: 50, FluidType: 1, CustomName: 'Aft water', Capacity: 0.3 }, 'tank.4');
  const entry = toSensorCacheEntry(t);
  assert.equal(entry.value, undefined);
  const back = fromSensorCacheEntry(JSON.parse(JSON.stringify(entry)));
  assert.equal(back.id, 'tank.4');
  assert.equal(back.kind, 'tank');
  assert.equal(sensorLabel(back), 'Aft water');
  assert.equal(back.value, undefined);
  assert.equal(sensorLabel(fromSensorCacheEntry(toSensorCacheEntry(sensor({ TemperatureType: 6 }, 'temperature.9')))), 'Freezer');
  assert.equal(fromSensorCacheEntry({ id: 'tank.1', instance: '1' }), null);
  assert.equal(fromSensorCacheEntry({ id: 'x.1', kind: 'x', instance: '1' }), null);
  assert.equal(fromSensorCacheEntry(null), null);
});

test('sensorEndpointIdFor produces stable, dot-free ids distinct from circuits', () => {
  assert.equal(sensorEndpointIdFor('tank.20'), 'tank-20');
  assert.equal(sensorEndpointIdFor('temperature.24'), 'temperature-24');
});
