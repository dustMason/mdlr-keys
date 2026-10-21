# Historical calibration workflows

`v1/` preserves the original four-case scripts, configs, README and evidence
byte-for-byte. Its old notes, crops and full-spectrum objective differ from v2;
its removed calibration fields must not be passed to the current engine.
The old README describes that historical result, not current behavior.

`structural-v2/` records the first corrected oscillator/controller architecture
and its six-axis analog fit. It still treated high-frequency shape-calibration
excursion as unity. `excursion-v2/` records the subsequent physically bounded
common-excursion correction and seven-axis training search. Both use the frozen
seven-case corpus and exclude validation during tuning. Final exact-source
validation is in `../evidence/current-*.json`.

No source audio, patch containers, firmware or compiled binaries are stored here.
