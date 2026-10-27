# TODO

- [x] Verify pairing and two-way control with Apple Home on a real GX
- [ ] Verify pairing and two-way control with Google Home (and ideally Alexa / SmartThings)
- [ ] Support the remaining Victron output types. Each needs a Matter mapping decision and real hardware to verify against:
  - Stepped switch (4) / three-state (9): a dimmable light whose level snaps to steps, or a Matter Mode Select device (not widely supported by Home apps)
  - Dropdown (6): Mode Select, same caveat
  - Basic slider (7) / numeric input (8): Level Control with DimmingMin/Max scaling
  - Temperature setpoint (3): Thermostat
  - RGB / CCT / RGBW color wheels (11–13): Extended Color / Color Temperature Light
  - Bilge pump control (10): unclear what the GX exposes
