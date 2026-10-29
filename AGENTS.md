# signalk-venus-matter

A Signal K plugin (Node.js, CommonJS) that exposes Victron digital switching circuits as Matter devices through a [matter.js](https://github.com/matter-js/matter.js) bridge.

## Project layout

- `index.js`: the plugin factory. It handles schema, start/stop, circuit discovery, the Matter→GX write path, and the `/status` route
- `lib/circuits.js`: pure helpers covering Venus MQTT topic parsing, the circuit model, device-type resolution, and Victron↔Matter value conversion. No I/O.
- `lib/sensors.js`: pure helpers for read-only GX sensors (tanks, temperature probes): topic parsing, the sensor model, labels, and the mapping to Matter measurement values. No I/O.
- `lib/venus-client.js`: the `VenusClient` class, an MQTT client for the GX's local FlashMQ broker (portal-id discovery, keepalive, subscriptions, writes)
- `lib/matter-bridge.js`: the `MatterBridge` class, which wraps matter.js (`ServerNode` + `AggregatorEndpoint` + one bridged endpoint per circuit)
- `src/configpanel/`: the React plugin configuration panel, loaded by the Signal K admin UI via webpack Module Federation (same setup as signalk-navico-embedder). Built with `npm run build:config` into `public/` (gitignored; also built by `prepublishOnly`). It polls `GET /plugins/signalk-venus-matter/status` (admin-only), which returns the bridge state, pairing codes with a QR SVG (rendered server-side with `qrcode`), and `buildCircuitReport()` output. It saves the whole plugin config through the `save` prop. Circuit overrides are stored only when they differ from the defaults.
- `test/`: Node built-in test runner (`npm test`). Tests never start the Matter stack or connect to a GX.
- `CHANGELOG.md`: `# vX.Y.Z (YYYY-MM-DD)` headings. The publish workflow extracts release notes from it.

## Why direct MQTT instead of Signal K paths

signalk-venus-plugin (v2.4.1) caches the SwitchableOutput `Type` per device instance instead of per channel, so `dimmingLevel` vs `switchValue` paths get assigned to the wrong circuits. We talk to the GX directly to get each channel's real type. Signal K is only the host process here: it provides config, status, and the data dir.

## Data flow

**GX → Matter:** `VenusClient` learns the portal id from `N/+/system/0/Serial`, subscribes to `N/<portal>/switch/+/SwitchableOutput/#`, `N/<portal>/system/0/SwitchableOutput/#` (the GX's own relays), and `N/<portal>/switch/+/CustomName` (module names). It then sends `R/<portal>/keepalive`: empty for a full republish after each (re)connect, then `suppress-republish` every 30s (the GX stops publishing after 60s without a keepalive). `index.js` folds each field into a circuit model keyed `<service>.<instance>.<channel>` and waits `DISCOVERY_SETTLE_MS` before adding endpoints. After that, `State`/`Dimming` changes call `bridge.updateCircuit()`.

**Matter → GX:** `MatterBridge` listens to `onOff$Changed` and `levelControl.currentLevel$Changed` and calls `onCommand(circuit, 'state'|'dimming', value)`. `index.js` then publishes `W/<portal>/<service>/<instance>/SwitchableOutput/<channel>/State|Dimming` with `{"value": ...}`. Echo suppression: the bridge stores the last GX value on each circuit and ignores Matter change events that match it.

**Which outputs get bridged** (`isBridgeable`): `Settings/Type` must be 0 (momentary), 1 (toggle) or 2 (dimmable), and the output must not have `ShowUIControl = 0` or `ValidTypes = 0`. New circuits also need a non-null `State` (GX relays assigned to another function report null). A circuit that is already bridged is kept when its State goes null, and shown as unreachable instead, because removing an endpoint makes Home apps forget its room and automations. Momentary outputs are opt-in (`isEnabled`): they're only bridged when the override has `enabled: true`. A Matter "on" writes `State=1`, then `State=0` after `MOMENTARY_PULSE_MS`, and flips the Matter switch back off.

**Keeping the bridge in sync** (`syncEndpoints`, debounced by `DISCOVERY_SETTLE_MS` after any settings-type field changes): circuits no longer wanted are removed, a changed Matter device type is removed and re-added under the same endpoint id, and a changed label is updated in place (`nodeLabel`). Plugin config changes don't need any of this, because Signal K restarts the plugin on save.

**Circuit cache** (`bridged-circuits.json` in the data dir): after every sync, the bridged circuits' GX fields (type, names, group, module name, but not state) are saved with `toCacheEntry`. On start, `restoreCachedCircuits` re-adds them as unreachable before the GX connects, so a controller reconnecting right after a restart doesn't find an empty bridge. Restored circuits live in the `restored` map until the GX reports them. `syncEndpoints` never removes a restored circuit the GX hasn't reported (module offline or removed). Only an explicit `enabled: false` override removes it, and the panel flags these as `missing`. Reset pairing deletes the cache.

**Reachability** (`isReachable`): GX MQTT connected, the circuit's module `Connected` isn't 0, and `State` isn't null. It's refreshed on GX connect/disconnect, module `Connected` changes, and State changes.

**Sensors (tanks and temperature probes):** `lib/sensors.js` describes each read-only sensor kind in `SENSOR_KINDS` (value field, type field, label rules, Matter conversion, and the settings array for overrides: `tanks`, `temperatures`). `VenusClient` subscribes to `sensorTopics()`: a fixed list of `N/<portal>/<kind>/+/<field>` topics, not `#`, because `RawValue` changes constantly. Matter has no tank device type, so a tank is a bridged `HumiditySensorDevice` whose `measuredValue` is the level rounded to whole percent ×100. A temperature probe is a `TemperatureSensorDevice` rounded to 0.1 °C, with min/max left null. Sensor ids are `<kind>.<instance>` and endpoint ids are `<kind>-<instance>`. Sensors are read-only, enabled unless overridden with `enabled: false`, and bridged once they report a value. Unnamed sensors that share a type label get the instance appended (`autoLabels`). Value pushes are rate-limited per sensor by `SENSOR_UPDATE_MIN_MS` (the latest value wins). Only a label change (`CustomName`, type field) or a sensor's first reading triggers `syncEndpoints`, which calls `syncSensors`. Bridge entries carry a `kind` (`circuit`/`tank`/`temperature`), and circuit sync only touches `bridge.ids('circuit')`. Sensors have their own cache (`bridged-sensors.json`, `restoredSensors`) with the same restore and keep-when-missing rules as circuits. A sensor is reachable when the GX is connected, `Connected` isn't 0, `Status` is 0, and it has a value.

**Logging:** `routeMatterLogging` replaces matter.js's global default log destination. Info and above go to `app.debug`, and error and above go to `app.error`.

**GX address fallback** (`detectGxFromVenusPlugin`): if `gxHost` is blank, it's read from `plugin-config-data/venus.json`: `mqtt`/`mqtts` use `MQTT.host`, `local` uses 127.0.0.1, and `remote` uses `host=` from `dbusAddress`. Device type: Type 2 becomes a dimmable light. For Type 1, a lighting-like circuit name becomes a light, a pump/fan/fridge/etc. name becomes an outlet, and otherwise the group name decides (defaulting to outlet). Labels use `Settings/CustomName`, then `Name`, then module name + channel.

Victron SwitchableOutput reference: the "switch" section of https://github.com/victronenergy/venus/wiki/dbus. MQTT protocol: https://github.com/victronenergy/dbus-flashmq.

## Matter specifics

- Endpoint IDs (`circuit-<service>-<instance>-<channel>`) must stay stable across restarts, because controllers key their accessories off them. They're based on the hardware channel, so renames on the GX don't break pairing
- Level: Matter `currentLevel` is 1–254 and GX `Dimming` is 0–100. Convert with `percentToMatterLevel`/`matterLevelToPercent`, which must round-trip every integer percent or echo suppression breaks (there's a test for this)
- Bridge identity (uniqueId, passcode, discriminator) lives in `<dataDir>/bridge-identity.json`. matter.js fabric storage lives in `<dataDir>/matter/`.
- Vendor ID is 0xFFF1 (CSA test vendor), so controllers will show an "uncertified" warning

## Local development

```bash
npm install
npm link
cd ~/.signalk && npm link signalk-venus-matter
signalk-server --port 3000
```

Restart the server after changes to `index.js`/`lib/`. Run `npm run build:config` after changes to `src/configpanel/`, then reload the admin UI. Set the GX IP in the plugin config. To inspect what the GX publishes, subscribe to `N/<portal>/switch/#` on the GX's port 1883 after sending an empty publish to `R/<portal>/keepalive`.

## Code style

ESLint (`@stylistic`) owns JS formatting and Prettier owns JSON/YAML. Run `npm run format` before committing (husky + lint-staged also do this). Use semver, and always update `CHANGELOG.md` when bumping the version. See `RELEASE.md`.
