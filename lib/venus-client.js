// MQTT client for a Victron GX device (Cerbo GX, etc.) running Venus OS. Talks to
// the GX's local FlashMQ broker directly, so the plugin doesn't depend on how
// (or whether) signalk-venus-plugin maps switch data into Signal K.
//
// Venus MQTT protocol (github.com/victronenergy/dbus-flashmq):
//   - The portal id is learned from the retained-ish N/<portal>/system/0/Serial.
//   - Nothing is published unless a keepalive is sent to R/<portal>/keepalive
//     at least every 60s. An empty payload triggers a full republish of every
//     value; {"keepalive-options":["suppress-republish"]} just keeps it alive.
//   - Writes go to W/<portal>/<path> with payload {"value": ...}, not retained.
const EventEmitter = require('events');
const mqtt = require('mqtt');

const { sensorTopics } = require('./sensors');

const KEEPALIVE_INTERVAL_MS = 30 * 1000;
const SUPPRESS_REPUBLISH = JSON.stringify({ 'keepalive-options': ['suppress-republish'] });

class VenusClient extends EventEmitter {
  constructor({ host, port, tls, username, password }) {
    super();
    this.options = { host, port, tls, username, password };
    this.client = null;
    this.portalId = null;
    this.keepaliveTimer = null;
  }

  start() {
    const { host, port, tls, username, password } = this.options;
    const url = `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`;
    this.client = mqtt.connect(url, {
      username: username || undefined,
      password: password || undefined,
      // The GX uses a self-signed certificate on its local TLS port.
      rejectUnauthorized: false,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    this.client.on('connect', () => {
      this.emit('connect');
      if (this.portalId) {
        this.subscribeSwitches();
      } else {
        this.client.subscribe('N/+/system/0/Serial');
      }
    });
    this.client.on('close', () => this.emit('offline'));
    this.client.on('error', (err) => this.emit('error', err));
    this.client.on('message', (topic, payload) => this.handleMessage(topic, payload));
  }

  handleMessage(topic, payload) {
    let value;
    try {
      ({ value } = JSON.parse(payload.toString()));
    } catch {
      return;
    }

    if (!this.portalId && topic.endsWith('/system/0/Serial')) {
      this.portalId = topic.split('/')[1];
      this.client.unsubscribe('N/+/system/0/Serial');
      this.emit('portal', this.portalId);
      this.subscribeSwitches();
      return;
    }

    this.emit('value', topic, value);
  }

  subscribeSwitches() {
    const p = this.portalId;
    this.client.subscribe([
      `N/${p}/switch/+/SwitchableOutput/#`,
      `N/${p}/system/0/SwitchableOutput/#`,
      `N/${p}/switch/+/CustomName`,
      `N/${p}/switch/+/Connected`,
      ...sensorTopics(p),
    ]);
    // Full republish once (after every (re)connect), then keep the session alive.
    this.client.publish(`R/${p}/keepalive`, '');
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (this.client && this.client.connected) {
        this.client.publish(`R/${p}/keepalive`, SUPPRESS_REPUBLISH);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  // Write a SwitchableOutput field, e.g. write(circuit, 'State', 1).
  write(circuit, field, value) {
    if (!this.client || !this.portalId) return false;
    const topic = `W/${this.portalId}/${circuit.service}/${circuit.instance}/SwitchableOutput/${circuit.channel}/${field}`;
    this.client.publish(topic, JSON.stringify({ value }));
    return true;
  }

  async stop() {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.endAsync();
    }
  }
}

module.exports = { VenusClient };
