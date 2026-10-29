import React, { useState, useRef, useCallback, useEffect } from 'react'

const STATUS_URL = '/plugins/signalk-venus-matter/status'
const RESET_URL = '/plugins/signalk-venus-matter/reset-pairing'
const POLL_MS = 5000

const DEVICE_TYPE_LABELS = {
  light: 'On/off light',
  dimmableLight: 'Dimmable light',
  outlet: 'Outlet / switch'
}

const S = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    padding: '16px 0'
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 10,
    marginTop: 24
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer'
  },
  btnSave: { background: '#10b981', color: '#fff' },
  btnSmall: { background: '#e2e8f0', color: '#333', padding: '4px 10px', fontSize: 12 },
  btnDanger: { background: '#ef4444', color: '#fff', padding: '6px 12px', fontSize: 12 },
  status: { marginTop: 8, fontSize: 12, minHeight: 18 },
  card: {
    display: 'flex',
    gap: 20,
    alignItems: 'center',
    flexWrap: 'wrap',
    padding: 16,
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 8
  },
  qr: { width: 180, height: 180, flexShrink: 0, background: '#fff', borderRadius: 6 },
  code: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 22, fontWeight: 600, letterSpacing: '0.08em' },
  pairInfo: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220, flex: 1 },
  dot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 },
  label: { fontSize: 13, fontWeight: 500, color: '#555', width: 160, flexShrink: 0 },
  fieldBody: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  input: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    width: 220,
    background: '#fff',
    color: '#333'
  },
  checkbox: { width: 16, height: 16, cursor: 'pointer', accentColor: '#3b82f6' },
  hint: { fontSize: 11, color: '#aaa' },
  bankTitle: { fontSize: 13, fontWeight: 600, color: '#555', margin: '16px 0 6px' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    marginBottom: 6,
    flexWrap: 'wrap'
  },
  itemDisabled: { opacity: 0.45 },
  itemName: { flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 2 },
  itemInput: {
    padding: '5px 8px',
    borderRadius: 5,
    border: '1px solid #d5d5d5',
    fontSize: 13,
    fontWeight: 600,
    background: '#fff',
    color: '#333',
    width: '100%'
  },
  select: {
    padding: '5px 8px',
    borderRadius: 5,
    border: '1px solid #d5d5d5',
    fontSize: 13,
    background: '#fff',
    color: '#333'
  },
  toggle: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 },
  empty: { textAlign: 'center', padding: '30px 16px', color: '#999', fontSize: 13 },
  actions: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }
}

function TextField({ label, value, onChange, placeholder, hint, type = 'text' }) {
  return (
    <div style={S.fieldRow}>
      <span style={S.label}>{label}</span>
      <div style={S.fieldBody}>
        <input
          style={S.input}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {hint && <span style={S.hint}>{hint}</span>}
      </div>
    </div>
  )
}

function CheckboxField({ label, checked, onChange, hint }) {
  return (
    <div style={S.fieldRow}>
      <span style={S.label}>{label}</span>
      <div style={S.fieldBody}>
        <input style={S.checkbox} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {hint && <span style={S.hint}>{hint}</span>}
      </div>
    </div>
  )
}

function toNumberOrUndefined(value) {
  const n = Number(String(value).trim())
  return String(value).trim() === '' || Number.isNaN(n) ? undefined : n
}

// Only store overrides that differ from the defaults, so the saved config stays
// small and circuits keep following auto-detection unless the user changed them.
// `enabled` is undefined until the user touches the checkbox; the default is
// decided by the server (on, except momentary outputs).
function overrideFor(id, o) {
  const entry = { id }
  if (o.name && o.name.trim()) entry.name = o.name.trim()
  if (o.deviceType && o.deviceType !== 'auto') entry.deviceType = o.deviceType
  if (typeof o.enabled === 'boolean') entry.enabled = o.enabled
  return Object.keys(entry).length > 1 ? entry : null
}

// Plugin config array holding each sensor kind's overrides.
const SENSOR_SETTINGS_KEYS = { tank: 'tanks', temperature: 'temperatures' }

function sensorOverrideFor(id, o) {
  const entry = { id }
  if (o.name && o.name.trim()) entry.name = o.name.trim()
  if (o.enabled === false) entry.enabled = false
  return Object.keys(entry).length > 1 ? entry : null
}

// Two-step "Reset pairing" button: the first click arms it, the second resets.
// Avoids a browser confirm() dialog inside the admin UI.
function ResetPairingButton({ onReset }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!armed) return undefined
    const t = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(t)
  }, [armed])

  const click = async () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await fetch(RESET_URL, { method: 'POST', credentials: 'same-origin' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onReset()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
      setArmed(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <button style={{ ...S.btn, ...S.btnDanger, ...(busy ? { opacity: 0.6 } : {}) }} onClick={click} disabled={busy}>
        {busy ? 'Resetting…' : armed ? 'Click again to confirm' : 'Reset pairing'}
      </button>
      {error && <span style={{ fontSize: 12, color: '#ef4444' }}>Reset failed: {error}</span>}
    </div>
  )
}

function PairingCard({ status, error, onReset }) {
  const [copied, setCopied] = useState(false)

  if (error) {
    return <div style={S.card}>Could not load bridge status: {error}</div>
  }
  if (!status) {
    return <div style={S.card}>Loading…</div>
  }
  if (!status.running) {
    return <div style={S.card}>The bridge is not running. Enter your GX device IP address below, enable the plugin and save.</div>
  }
  if (status.commissioned) {
    return (
      <div style={S.card}>
        <div style={S.pairInfo}>
          <div>
            <span style={{ ...S.dot, background: '#10b981' }} />
            <strong>Paired with:</strong>{' '}
            {(status.fabrics || []).map((f) => (f.label ? `${f.vendor} (${f.label})` : f.vendor)).join(', ')}
          </div>
          <div style={S.hint}>
            To add the bridge to another app, use "Turn On Pairing Mode" for the bridge in an app it's already paired
            with. To start over, remove the bridge from your apps, then reset pairing here. Resetting forgets every
            pairing and shows a new QR code. Any app still holding the old bridge will show it as "No Response" until
            you remove it there.
          </div>
          <ResetPairingButton onReset={onReset} />
        </div>
      </div>
    )
  }

  const { pairing } = status
  const copy = () => {
    navigator.clipboard.writeText(pairing.manualPairingCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  // Group the 11-digit manual code as 4-3-4, the way Home apps display it.
  const pretty = pairing.manualPairingCode.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1-$2-$3')

  return (
    <div style={S.card}>
      <div style={S.qr} dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
      <div style={S.pairInfo}>
        <div>
          Scan this code in the Apple Home, Google Home, or another Matter app (Add Accessory / Add Device), or enter the
          setup code manually:
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={S.code}>{pretty}</span>
          <button style={{ ...S.btn, ...S.btnSmall }} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div style={S.hint}>Your phone must be on the same network as the Signal K server.</div>
      </div>
    </div>
  )
}

function CircuitRow({ circuit, override, onChange }) {
  const enabled = typeof override.enabled === 'boolean' ? override.enabled : circuit.override.enabled
  const problems = [
    ...(circuit.missing ? ['Not reported by the GX (module offline or removed). Untick to remove it'] : []),
    ...(circuit.moduleConnected === false ? ['Module offline'] : []),
    ...(circuit.faults || [])
  ]
  if (circuit.skipReason) {
    return (
      <div style={{ ...S.item, ...S.itemDisabled }}>
        <div style={S.itemName}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{circuit.autoLabel}</span>
          <span style={S.hint}>
            Channel {circuit.channel} · {circuit.skipReason}
          </span>
        </div>
      </div>
    )
  }
  return (
    <div style={{ ...S.item, ...(enabled ? {} : S.itemDisabled) }}>
      <div style={S.itemName}>
        <input
          style={S.itemInput}
          value={override.name}
          placeholder={circuit.autoLabel}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <span style={S.hint}>
          Channel {circuit.channel}
          {circuit.group ? ` · ${circuit.group}` : ''}
          {circuit.dimmable ? ' · dimmable' : ''}
          {circuit.momentary ? ' · momentary (tapping it in an app gives a 0.5 s press)' : ''}
          {problems.length > 0 && <span style={{ color: '#ef4444' }}> · {problems.join(', ')}</span>}
        </span>
      </div>
      <select
        style={S.select}
        value={override.deviceType}
        onChange={(e) => onChange({ deviceType: e.target.value })}
      >
        <option value="auto">Auto ({DEVICE_TYPE_LABELS[circuit.autoDeviceType]})</option>
        <option value="light">{DEVICE_TYPE_LABELS.light}</option>
        {circuit.dimmable && <option value="dimmableLight">{DEVICE_TYPE_LABELS.dimmableLight}</option>}
        <option value="outlet">{DEVICE_TYPE_LABELS.outlet}</option>
      </select>
      <label style={S.toggle}>
        <input
          style={S.checkbox}
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        Show in Matter
      </label>
    </div>
  )
}

function formatSensorValue(sensor) {
  if (sensor.value === null) return ''
  if (sensor.kind === 'tank') return ` · ${Math.round(sensor.value)}%`
  return ` · ${sensor.value.toFixed(1)} °C (${((sensor.value * 9) / 5 + 32).toFixed(1)} °F)`
}

function SensorRow({ sensor, override, onChange }) {
  const enabled = override.enabled !== false
  const problems = [
    ...(sensor.missing ? ['Not reported by the GX (sensor offline or removed). Untick to remove it'] : []),
    ...(sensor.fault ? [sensor.fault] : [])
  ]
  const volume =
    sensor.remainingLitres !== null && sensor.capacityLitres
      ? ` · ${sensor.remainingLitres} of ${sensor.capacityLitres} L`
      : ''
  return (
    <div style={{ ...S.item, ...(enabled ? {} : S.itemDisabled) }}>
      <div style={S.itemName}>
        <input
          style={S.itemInput}
          value={override.name}
          placeholder={sensor.autoLabel}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <span style={S.hint}>
          {sensor.typeName || `Instance ${sensor.instance}`}
          {formatSensorValue(sensor)}
          {volume}
          {sensor.productName ? ` · ${sensor.productName}` : ''}
          {sensor.skipReason ? ` · ${sensor.skipReason}` : ''}
          {problems.length > 0 && <span style={{ color: '#ef4444' }}> · {problems.join(', ')}</span>}
        </span>
      </div>
      <label style={S.toggle}>
        <input
          style={S.checkbox}
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        Show in Matter
      </label>
    </div>
  )
}

function SensorSection({ title, sensors, empty, hint, getOverride, onChange }) {
  return (
    <>
      <div style={S.sectionTitle}>{title}</div>
      {sensors.length === 0 ? (
        <div style={S.empty}>{empty}</div>
      ) : (
        <>
          {hint && <div style={{ ...S.hint, marginBottom: 8 }}>{hint}</div>}
          {sensors.map((s) => (
            <SensorRow key={s.id} sensor={s} override={getOverride(s)} onChange={(patch) => onChange(s, patch)} />
          ))}
        </>
      )}
    </>
  )
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {}
  const [gxHost, setGxHost] = useState(cfg.gxHost || '')
  const [gxPort, setGxPort] = useState(cfg.gxPort === undefined ? '' : String(cfg.gxPort))
  const [gxTls, setGxTls] = useState(Boolean(cfg.gxTls))
  const [gxUsername, setGxUsername] = useState(cfg.gxUsername || '')
  const [gxPassword, setGxPassword] = useState(cfg.gxPassword || '')
  const [bridgeName, setBridgeName] = useState(cfg.bridgeName || 'Signal K Bridge')
  const [port, setPort] = useState(cfg.port === undefined ? '5540' : String(cfg.port))
  // circuit id -> { name, deviceType, enabled }, seeded from the saved config
  const [overrides, setOverrides] = useState(() => {
    const map = {}
    for (const c of cfg.circuits || []) {
      if (c && c.id) {
        map[c.id] = {
          name: c.name || '',
          deviceType: c.deviceType || 'auto',
          enabled: typeof c.enabled === 'boolean' ? c.enabled : undefined
        }
      }
    }
    return map
  })
  // sensor id -> { name, enabled }, for tanks and temperature sensors
  const [sensorOverrides, setSensorOverrides] = useState(() => {
    const map = {}
    for (const key of Object.values(SENSOR_SETTINGS_KEYS)) {
      for (const o of cfg[key] || []) {
        if (o && o.id) map[o.id] = { name: o.name || '', enabled: o.enabled !== false }
      }
    }
    return map
  })

  const [bridgeStatus, setBridgeStatus] = useState(null)
  const [statusLoadError, setStatusLoadError] = useState('')
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [saving, setSaving] = useState(false)
  const statusTimeoutRef = useRef(null)

  // Poll the bridge so the QR code, pairing state, and circuit list stay current
  // while the panel is open (circuits appear a few seconds after startup).
  const reloadRef = useRef(() => {})
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(STATUS_URL, { credentials: 'same-origin' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!cancelled) {
          setBridgeStatus(json)
          setStatusLoadError('')
        }
      } catch (e) {
        if (!cancelled) setStatusLoadError(e.message || String(e))
      }
    }
    reloadRef.current = load
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
      if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current)
    }
  }, [])

  const circuits = (bridgeStatus && bridgeStatus.circuits) || []
  const getOverride = (c) =>
    overrides[c.id] || { name: '', deviceType: 'auto', enabled: undefined }
  const updateOverride = (c, patch) =>
    setOverrides({ ...overrides, [c.id]: { ...getOverride(c), ...patch } })

  const sensors = (bridgeStatus && bridgeStatus.sensors) || []
  const getSensorOverride = (s) => sensorOverrides[s.id] || { name: '', enabled: true }
  const updateSensorOverride = (s, patch) =>
    setSensorOverrides({ ...sensorOverrides, [s.id]: { ...getSensorOverride(s), ...patch } })

  const banks = []
  for (const c of circuits) {
    let bank = banks.find((b) => b.name === c.bank)
    if (!bank) banks.push((bank = { name: c.bank, circuits: [] }))
    bank.circuits.push(c)
  }

  const doSave = useCallback(async () => {
    if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current)
    setSaving(true)
    setStatus('Saving…')
    setStatusError(false)
    try {
      const { passcode, discriminator, ...rest } = cfg // drop retired settings
      const config = {
        ...rest,
        gxHost: gxHost.trim(),
        gxPort: toNumberOrUndefined(gxPort),
        gxTls,
        gxUsername: gxUsername.trim() || undefined,
        gxPassword: gxPassword || undefined,
        bridgeName: bridgeName.trim() || undefined,
        port: toNumberOrUndefined(port),
        circuits: Object.entries(overrides)
          .map(([id, o]) => overrideFor(id, o))
          .filter(Boolean)
      }
      // Sensor ids start with their kind ("tank.20", "temperature.24").
      for (const [kind, key] of Object.entries(SENSOR_SETTINGS_KEYS)) {
        config[key] = Object.entries(sensorOverrides)
          .filter(([id]) => id.startsWith(`${kind}.`))
          .map(([id, o]) => sensorOverrideFor(id, o))
          .filter(Boolean)
      }
      const result = save(config)
      if (result && typeof result.then === 'function') {
        await result
      }
      setStatus('Configuration saved. Plugin will restart')
      setStatusError(false)
      statusTimeoutRef.current = setTimeout(() => setStatus(''), 5000)
    } catch (e) {
      setStatus('Save failed: ' + (e.message || e))
      setStatusError(true)
    } finally {
      setSaving(false)
    }
  }, [cfg, save, gxHost, gxPort, gxTls, gxUsername, gxPassword, bridgeName, port, overrides, sensorOverrides])

  const gxConnected = bridgeStatus && bridgeStatus.gxConnected

  return (
    <div style={S.root}>
      <div style={{ ...S.sectionTitle, marginTop: 0 }}>Pairing</div>
      <PairingCard status={bridgeStatus} error={statusLoadError} onReset={() => reloadRef.current()} />

      <div style={S.sectionTitle}>GX Device</div>
      <TextField
        label="GX IP address"
        value={gxHost}
        onChange={setGxHost}
        placeholder={
          bridgeStatus && bridgeStatus.detectedGxHost
            ? `${bridgeStatus.detectedGxHost} (from Venus plugin)`
            : 'e.g. 192.168.1.50'
        }
        hint={
          bridgeStatus && bridgeStatus.running ? (
            <span>
              <span style={{ ...S.dot, background: gxConnected ? '#10b981' : '#ef4444' }} />
              {gxConnected ? 'Connected' : 'Not connected'}
            </span>
          ) : (
            'MQTT access must be enabled on the GX'
          )
        }
      />
      <TextField label="MQTT port" value={gxPort} onChange={setGxPort} placeholder={gxTls ? '8883' : '1883'} hint="Leave blank for the default" />
      <CheckboxField label="Use TLS" checked={gxTls} onChange={setGxTls} hint="Only if the GX security profile requires encrypted MQTT" />
      <TextField label="MQTT username" value={gxUsername} onChange={setGxUsername} hint="Only if the GX requires a password" />
      <TextField label="MQTT password" type="password" value={gxPassword} onChange={setGxPassword} />

      <div style={S.sectionTitle}>Matter Bridge</div>
      <TextField label="Bridge name" value={bridgeName} onChange={setBridgeName} hint="Shown when pairing (max 32 characters)" />
      <TextField label="Matter port" value={port} onChange={setPort} hint="default 5540" />

      <div style={S.sectionTitle}>Circuits</div>
      {circuits.length === 0 ? (
        <div style={S.empty}>
          {bridgeStatus && bridgeStatus.running
            ? 'No circuits discovered yet. Check the GX connection above.'
            : 'Circuits will appear here once the plugin is running and connected to the GX.'}
        </div>
      ) : (
        banks.map((bank) => (
          <div key={bank.name}>
            <div style={S.bankTitle}>{bank.name}</div>
            {bank.circuits.map((c) => (
              <CircuitRow
                key={c.id}
                circuit={c}
                override={getOverride(c)}
                onChange={(patch) => updateOverride(c, patch)}
              />
            ))}
          </div>
        ))
      )}

      <SensorSection
        title="Tanks"
        sensors={sensors.filter((s) => s.kind === 'tank')}
        empty="No tank senders reported by the GX."
        hint="Matter has no tank sensor, so each tank shows up as a humidity sensor whose humidity is the tank level. In Apple Home, put tanks in a room of their own so they don't skew that room's humidity."
        getOverride={getSensorOverride}
        onChange={updateSensorOverride}
      />
      <SensorSection
        title="Temperatures"
        sensors={sensors.filter((s) => s.kind === 'temperature')}
        empty="No temperature sensors reported by the GX."
        hint="Shown as temperature sensors. Home apps display them in the unit set on your phone."
        getOverride={getSensorOverride}
        onChange={updateSensorOverride}
      />

      <div style={S.actions}>
        <button style={{ ...S.btn, ...S.btnSave, ...(saving ? { opacity: 0.6 } : {}) }} onClick={doSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
      </div>
      <div style={{ ...S.status, color: statusError ? '#ef4444' : '#10b981' }}>{status}</div>
    </div>
  )
}
