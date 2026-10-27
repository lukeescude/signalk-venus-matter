# v1.0.0 (2026-10-27)

First public release.

- Exposes Victron digital switching outputs as Matter devices through a single Matter bridge, so they can be controlled from Apple Home, Google Home, and other Matter apps
- Connects directly to the Cerbo GX / Venus OS device over its local MQTT broker. Works with any number of switching modules, and uses the circuit and module names set on the GX
- Dimmable outputs become dimmable lights. Toggle outputs become lights or outlets based on their name and group. Momentary outputs can be exposed as opt-in switches that give a 0.5 s press
- Two-way state sync, including brightness
- Configuration panel with a scannable pairing QR code and copyable setup code, GX connection status, the list of paired apps, a two-step **Reset pairing**, and a per-circuit list for renaming, choosing the Matter device type, and hiding circuits
- Follows changes on the GX without a restart: hidden or retyped outputs are removed or rebuilt, and renames update in place
- Circuits on an offline switching module, or while the GX connection is down, show as "No Response" instead of being removed, so Home apps keep their rooms and automations
- Remembers its circuits across restarts, so Home apps reconnecting after a Signal K restart find their accessories straight away
- Output faults (tripped, over temperature, short circuit) and offline modules are shown in the panel
- Uses the GX address from the Victron Venus plugin's settings when none is configured
- matter.js logging goes to the Signal K plugin log
