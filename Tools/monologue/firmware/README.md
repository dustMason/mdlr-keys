# Reproduce the monologue firmware investigation

No firmware binaries are included. Obtain the official 2.00 Windows updater
from the [Korg support page](https://www.korg.com/us/support/download/software/0/733/3529/)
and keep downloaded/generated files outside the source tree. Python 3 and `7z`
are required for extraction. The input hash is checked before unpacking.

```sh
python3 Tools/monologue/firmware/extract_firmware.py /path/to/updater.zip /tmp/monologue-analysis
python3 Tools/monologue/firmware/extract_controls.py /tmp/monologue-analysis
python3 Tools/monologue/firmware/wrap_voice_elf.py /tmp/monologue-analysis
```

The second command reproduces `control-evidence.json`; the third creates an
analysis-only ELF containing unchanged voice bytes, loaded at address zero.

REA 6.4.0 was used without registering an MCP server or changing client settings:

```sh
npx -y rea-agents@6.4.0 inspect-artifact /path/to/updater.zip --format json
GHIDRA_INSTALL_DIR=/path/to/ghidra_12.1.4_PUBLIC npx -y rea-agents@6.4.0 decompile /tmp/monologue-analysis/voice-analysis.elf 0x8f54 --provider ghidra --format json
```

The provider needs a suitable Java runtime and a native decompiler matching the
host architecture. On this Mac the decompiler bundled as source in Ghidra was
built locally; no vendor target code was executed. Native CLI sessions close on
completion. `rea-provenance.json` retains successful Evidence IDs and limitations.

For repeated focused work, a saved Ghidra headless project avoids cold imports:

```sh
/path/to/ghidra/support/analyzeHeadless /tmp/monologue-ghidra monologue -import /tmp/monologue-analysis/voice.bin -processor ARM:LE:32:Cortex -scriptPath Tools/monologue/firmware/ghidra -preScript VoiceInit.java
/path/to/ghidra/support/analyzeHeadless /tmp/monologue-ghidra monologue -process voice.bin -noanalysis -scriptPath Tools/monologue/firmware/ghidra -postScript MonologueDump.java /tmp/monologue-decompiled 0x423c 0x4708 0x49bc 0x845c
```

Use `MonologueInit.java` for the main image. Ghidra may merge tail-called helper
bodies into their callers; verify arithmetic and function boundaries with Thumb
disassembly rather than treating all decompiler types as authoritative. The
scripts write derived text only to the chosen analysis directory.

See `docs/monologue-firmware-evidence.md` for findings, addresses, clock derivation
and unresolved analog modeling questions. The structured JSON contains control
data and factual mappings, not executable vendor firmware.
