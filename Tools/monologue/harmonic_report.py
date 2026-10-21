#!/usr/bin/env python3
"""Entry point for the active v2 Monologue calibration workflow."""
import runpy
import sys
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().parent / 'v2/harmonic_report_v2.py'), run_name='__main__')
