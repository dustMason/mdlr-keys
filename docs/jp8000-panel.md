# JP-8000 panel: development contract

Mode: Operate. Pinned reference: original Roland JP-8000 front panel; slate painted chassis, orange printed section names, warm white legends, black rotary controls, pale horizontal fader caps, dark rectangular switches, amber/olive character LCD. The reference photograph is evidence only and is not shipped in the UI.

Expand the incumbent mdlr panel world using its TouchFader and useKnobControl gesture model. Preserve existing engines. The JP panel has Sound, Performance, Assignments and physical Panel views; it never synthesizes substitute audio. Ready and LCD are supplied by the native firmware host. A browser-only preview cannot claim an active instrument and its editing controls remain inactive.

Primary layouts: 1056×746 landscape and 786×1016 portrait. At default zoom no target shrinks below 44 CSS px. Reflow synthesis sections rather than scaling a photograph or shrinking gestures. Maintain upper/lower/both editing separately from Single/Dual/Split key mode. Factory performances and factory patches are distinct actions. Full control details are in App/JP8000Controls.json; native IDs match wire offsets and category prefixes.

Bridge contract: parameter `{type:'parameter',engine:4,id,value}`; actions `{type:'jpAction',engine:4,action:'part'|'patch'|'performance'|'panel',value:integer}`. The parent rejects stale engine commands. Incoming `jp` has ready/status/lcd/part/params/patch_name/midi_channels. Full per-part mirroring is native-owned. Panel actions are actual numeric matrix button taps, not simulated screen changes. Native app owns firmware loading, audio, state persistence and factory data.

## Visual references

The layout, printed terminology and control shapes were checked against the
[Roland JP-8000 owner’s manual](https://static.roland.com/assets/media/pdf/JP-8000_OM.pdf)
and this [front-panel photograph](https://www.presetpatch.com/Images/Instruments/162/roland-jp-8000.jpg).
The rendered panel is built from interactive controls and CSS; the photograph is
not included in the app. Where a manual table conflicts with executed firmware,
the label follows the measured firmware behavior, as documented below.

## QA inventory

- Landscape and portrait: all main sections, persistent LCD/part/preset controls and view navigation fit; inspect actual screenshots and numeric bounds.
- No horizontal overflow, no intersecting controls, 44 px minimum interactive targets, readable legends and disabled/boot state.
- All 167 metadata IDs unique, each raw range and labels array valid; every rendered lookup resolves.
- Control gestures and keyboard arrows emit bounded integer engine 4 parameter messages; waveform changes relabel shared OSC 1 sliders.
- Part, patch, performance and panel actions emit distinct integer messages. Switching views changes only UI; inactive browser preview emits no instrument events.
- Off-happy-path: firmware not ready disables edits; failed status remains visible; lower/both selection and out-of-range incoming values cannot crash enum labels.
- Other four engine panels still mount through unchanged definitions.
- UI event tests may inject a native bridge fixture explicitly labeled UI QA; they establish interface wiring only, not audio or hardware parity.

Verification is bounded: one batched landscape/portrait/function pass, one repair batch, one confirmation pass. Native audio/core tests belong to the app integration owner.

## Verification receipt (2026-10-21)

`npm run check` and `npm run build` passed. Muted headless Chromium checks used a native-message fixture explicitly labeled “UI QA fixture · no audio”; the Chariots LCD, main patch and common-performance values came from the earlier real firmware boot readback. Remaining values are metadata defaults. This is a logical viewport and bridge test, not an iPad/audio qualification.

Sound, Performance and Panel fit 1056×746 and 786×1016 without horizontal or section overflow. Every visible interactive target in all four views measured at least 44×44 CSS pixels. Assignments has intentional vertical scrolling for the full controller matrix. Screenshots and machine-readable receipts live in the task's private `work/mdlr-jp8000/qa` folder, outside the app bundle.

Verified cutoff and waveform parameter events, dynamic OSC 1 labels, distinct upper/lower/both, factory patch, factory performance and numeric panel events; all send engine 4. Incoming lower-part patch names replace previous names, and a patch LCD clears a stale performance placeholder. Starting and browser-preview states disable controls; browser preview has no fake audio path. All four original engines still mount (23/8/21/25 visible sliders). No browser exceptions were reported.

All 167 metadata IDs are unique, ranges/defaults are integers and valid, enum arrays cover the raw range, and labels contain no internal CamelCase names. The native app owns final firmware behavior and persistence. OSC 2 labels now follow executed firmware v1.05: raw 0 PULSE, raw 1 SAW, raw 2 TRIANGLE. An isolated OSC 2 audio test resolves the conflicting manual/C++ ordering (saw 1/n harmonics versus triangle odd 1/n² harmonics). Evidence: `work/jp8000/research/native-integration/osc2-waveform-evidence.json`.

Finish-review fixes: JP controls provide an optional formatter to the existing gesture hook, keeping the large gesture readout and accessible value aligned with parameter labels (including Master Tune units and signed controller amounts). Other engines retain the original default formatter. Startup and error status text wraps across the full panel width; it does not depend on a hover tooltip.

Focused finish verification passed typecheck/build and muted headless pointer assertions: Master Tune raw 50 formats as 440.0 Hz (the existing big readout applies uppercase text styling), ribbon assignment raw 127 as 0, JP fader accessible/gesture values agree, and all four legacy engines retain matching gesture/accessible values. A synthetic long error with an unbroken diagnostic name wraps without clipping at both target viewports. Receipt: `work/mdlr-jp8000/qa/finish-fixes-results.json`.

The single prescribed detector run reported two reviewed style findings: an underline on zero-radius navigation tabs was classified as a rounded-card accent, and Arial was flagged despite the pinned hardware/incumbent typography. Both were reviewed with the integration owner; no redesign or detector suppression was applied. Full command, output and disposition: `work/mdlr-jp8000/qa/impeccable-detector.txt`.

## Grid refinement (2026-10-21)

The header uses equal thirds of the same 12-column layout and 12 px gutters: LCD on the left, JP-8000 centered, part selection on the right. Main sound sections use 2/4/3/3 and 6/3/3 column spans, with consistent control gaps. OSC 1/2 fader tracks and FILTER/AMP envelope tracks share their vertical baselines. Tick marks extend to the edges of the 6 px center slot. Performance upper groups have a common height so the dropdown rows align; portrait MIDI labels reserve two lines.

Routine identity/status captions and the redundant Panel hint are removed. Startup and error messages remain visible and wrap. Silent recorded-state QA is documented in the capture receipt rather than printed on the instrument panel. This supersedes the earlier requirement to label the fixture visibly inside the panel.

## Secondary-page usability (2026-10-21)

Assignments now presents six destination groups and an Assigned view instead of an unstructured 40-knob matrix. Each source retains all 40 destinations. Horizontal bipolar amount controls show signed values, nonzero amounts and a per-row Zero action. Zero sends raw 127, including for the narrower OSC 2 ranges. Oscillator 1 labels follow the selected waveform; filter sustain accounts for the different Velocity key spelling. A focused row stays present in Assigned while it crosses zero. BOTH mode explicitly shows Upper readback, and Zero remains available even if Upper is already zero so Lower can also be cleared.

The Filter group fits all ten rows in the target landscape viewport. A long Assigned list scrolls inside the editor, keeping source/group navigation visible; vertical touch scrolling is allowed over sliders. Touch edits wait until a horizontal drag or tap release, so a vertical swipe does not change an assignment on touch-down. Native keyboard and mouse editing remain available. Velocity-off status stays beside the part label. Performance puts Internal/MIDI clock selection beside tempo and spells out BPM and Lower/Upper voice allocation. Panel navigation and motion selection are separated from momentary WRITE and RECORD actions. Trigger-channel labels are corrected to 1–16 without changing their 0–15 wire values.
