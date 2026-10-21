"""Reference-only cache for the frozen experimental metric_audit comparator.

This module clones the existing function code with private helper bindings; it
neither changes its algorithm nor monkeypatches metric_audit globals. Candidates
are always reread. Reference identity includes file metadata, and feature keys
include the exact aligned array slice and all analysis arguments. Each instance
has bounded LRU caches; concurrent calls have independent ContextVar state.
"""

from collections import OrderedDict
from contextvars import ContextVar
from pathlib import Path
from threading import RLock
from types import FunctionType
import inspect
import numpy as np
import metric_audit as _metric


def _clone(function, namespace):
    clone = FunctionType(
        function.__code__,
        namespace,
        function.__name__,
        function.__defaults__,
        function.__closure__,
    )
    clone.__kwdefaults__ = function.__kwdefaults__
    return clone


def _identity(path, rate):
    resolved = Path(path).resolve()
    stat = resolved.stat()
    return (
        str(resolved),
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
        stat.st_ctime_ns,
        rate,
    )


class ReferenceCache:
    """Call compare_files repeatedly. clear() releases cached reference arrays.

    max_references and max_features bound memory. Array/frame results never leave
    the comparator directly. The original algorithm only reads these features.
    """

    def __init__(self, max_references=16, max_features=256):
        if max_references < 1 or max_features < 1:
            raise ValueError("Cache bounds must be positive")
        self.max_references = max_references
        self.max_features = max_features
        self._references = OrderedDict()
        self._lock = RLock()
        self._active = ContextVar("metric_reference", default=None)
        self.stats = {
            key: 0
            for key in [
                "audio_hits",
                "audio_misses",
                "pitch_hits",
                "pitch_misses",
                "frame_hits",
                "frame_misses",
            ]
        }
        namespace = dict(_metric.__dict__)
        namespace.update(
            read_audio=self._read_audio,
            pitch=self._pitch,
            harmonic_frames=self._harmonic_frames,
        )
        namespace["compare_harmonic_arrays"] = _clone(
            _metric.compare_harmonic_arrays, namespace
        )
        self._compare = _clone(_metric.compare_files, namespace)
        self._frame_signature = inspect.signature(_metric.harmonic_frames)

    def clear(self):
        with self._lock:
            self._references.clear()

    def _lookup(self, cache, key):
        with self._lock:
            if key not in cache:
                return False, None
            value = cache.pop(key)
            cache[key] = value
            return True, value

    def _save(self, cache, key, value, limit):
        with self._lock:
            cache[key] = value
            cache.move_to_end(key)
            while len(cache) > limit:
                cache.popitem(last=False)

    def _bump(self, key):
        with self._lock:
            self.stats[key] += 1

    def _read_audio(self, path, rate=24000):
        active = self._active.get()
        # The comparator reads reference first, candidate second. Only the first
        # read may use the reference cache, even in the self-comparison case.
        if active is None or active["read_count"] != 0:
            return _metric.read_audio(path, rate)
        active["read_count"] += 1
        identity = _identity(path, rate)
        hit, entry = self._lookup(self._references, identity)
        if hit:
            self._bump("audio_hits")
        else:
            self._bump("audio_misses")
            audio, sr = _metric.read_audio(path, rate)
            audio.flags.writeable = False
            entry = {
                "audio": audio,
                "sr": sr,
                "pitch": OrderedDict(),
                "frames": OrderedDict(),
            }
            self._save(self._references, identity, entry, self.max_references)
        active["entry"] = entry
        return entry["audio"], entry["sr"]

    def _slice(self, array):
        active = self._active.get()
        entry = None if active is None else active.get("entry")
        if entry is None:
            return None
        original = entry["audio"]
        if (
            array.ndim != 1
            or array.strides != original.strides
            or not np.shares_memory(array, original)
        ):
            return None
        offset = (
            array.__array_interface__["data"][0]
            - original.__array_interface__["data"][0]
        ) // original.itemsize
        return entry, (int(offset), len(array))

    def _pitch(self, array, sr):
        match = self._slice(array)
        if match is None:
            return _metric.pitch(array, sr)
        entry, slice_key = match
        key = (slice_key, sr)
        hit, result = self._lookup(entry["pitch"], key)
        if hit:
            self._bump("pitch_hits")
        else:
            self._bump("pitch_misses")
            result = _metric.pitch(array, sr)
            self._save(entry["pitch"], key, result, self.max_features)
        return None if result is None else dict(result)

    def _harmonic_frames(self, array, *args, **kwargs):
        match = self._slice(array)
        if match is None:
            return _metric.harmonic_frames(array, *args, **kwargs)
        entry, slice_key = match
        bound = self._frame_signature.bind(array, *args, **kwargs)
        bound.apply_defaults()
        key = (slice_key, tuple((k, v) for k, v in bound.arguments.items() if k != "x"))
        hit, result = self._lookup(entry["frames"], key)
        if hit:
            self._bump("frame_hits")
        else:
            self._bump("frame_misses")
            result = _metric.harmonic_frames(array, *args, **kwargs)
            for value in result.values():
                value.flags.writeable = False
            self._save(entry["frames"], key, result, self.max_features)
        return result

    def compare_files(
        self,
        reference,
        candidate,
        max_lag_ms=0,
        *,
        pitch_hz=None,
        start_s=0.075,
        end_s=None,
    ):
        token = self._active.set({"read_count": 0})
        try:
            return self._compare(
                reference,
                candidate,
                max_lag_ms,
                pitch_hz=pitch_hz,
                start_s=start_s,
                end_s=end_s,
            )
        finally:
            self._active.reset(token)


_default = ReferenceCache()
compare_files = _default.compare_files
