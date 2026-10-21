# Headless JP-8000 Host regression tests

These standalone C++20 programs never open an audio/MIDI device, launch the app or play sound. They compile the repository's `App/JP8000Host.hpp` directly. Test-only compilation injects a 500 ms persistence-worker delay, and the callback allocation probe is confined to each standalone binary. Do not add these sources to the app target.

From any working directory, run:

```sh
/path/to/mdlr-keys/Tests/run-jp8000-host-tests.sh fixture
/path/to/mdlr-keys/Tests/run-jp8000-host-tests.sh core \
  /path/to/libmdlr_jp8000.a /path/to/jp8000_v1.05.bin /path/to/ram_dump.bin
```

The fixture needs Clang, ASan/UBSan and the checked-in C API header; it does not need firmware or a native archive. The core test needs a macOS arm64 native archive built with `Scripts/build-jp8000.sh`, an independently supplied 512 KiB JP-8000 v1.05 ROM and the 256 KiB baseline RAM image. Inputs remain read-only; no downloads occur. The native archive must match the current C header and Host. Set `CXX` to another compatible compiler if needed.

The script prints a JSON result path on success and leaves its binary, state files and receipts in a new temporary directory for inspection. Nonzero status means a compiler/assertion/runtime failure; the core probe returns 2 for streaming underruns. The actual compile/run commands are in the short script. To run binaries directly, the fixture accepts one new state-directory path; the core accepts ROM, baselineRAM and a new state-directory path. Both reject existing state directories so an earlier autosave cannot change their starting state.

`JP8000HostFixtureTests.cpp` is a deterministic C API contract fixture, not synthesis or firmware. It checks 20,000 concurrent MPSC deliveries, system/common/realtime MIDI preservation, full-velocity mode, callback allocations, stop/restart epochs, asynchronous persistence, failed-load recovery and control coalescing/fairness. It also measures the actual resampler on sine inputs. Assertions must remain enabled (`-UNDEBUG`).

`JP8000HostConcurrentTests.cpp` links the actual firmware engine. A dedicated 128-frame callback thread runs independently of the UI and a 1,200-events/sec control flood. It checks 625-byte genuine state restoration, actual firmware PanelSelect/panel readback, callback allocations, steady streaming underruns and inactive silence. It reports cold-ready, noise-threshold note onset, switch onset, callback scheduling lateness and native snapshots. The original baseline RAM determines the initial patch; note-on timing includes that patch's envelope and is not a hardware MIDI latency measurement.

Timing-sensitive checks should run on an otherwise lightly loaded machine. Host scheduling can cause failures on overloaded CI machines; inspect callback lateness before attributing an underrun to the producer. These tests do not qualify iPad scheduling, thermal headroom or physical audio/MIDI latency. `JP8000HostMeasurements.json` is a sanitized historical headless Mac receipt, not a universal performance guarantee.
