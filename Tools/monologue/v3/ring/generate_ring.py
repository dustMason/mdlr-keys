#!/usr/bin/env python3
"""Reproduce monologue ring diode table from the published circuit, not audio.

Python/numpy are offline dependencies only. D29..32 part number is unknown.
Nominal diode law approximates the ROHM 1SS355 25 C forward curve; use of that
law is an explicit component assumption, not identification of the Korg part.
"""
from pathlib import Path
import hashlib
import json
import math
import numpy as np

HERE = Path(__file__).resolve().parent
IS = 1e-9
NVT = 0.1 / math.log(10.0)
MAX_VOLTS = 1.5
VOLTS_PER_UNIT = 0.55
NA, NB = 129, 65


def residual(x, source, diode_is=IS, diode_nvt=NVT, jacobian=False):
    # Scale KCL by 10 kOhm for numerical conditioning: residual units are volts.
    e = np.exp(np.clip((x - np.roll(x, -1, axis=1)) / diode_nvt, -100, 60))
    currents = 10000 * diode_is * (e - 1)
    f = x - source + currents - np.roll(currents, 1, axis=1)
    f[:, 1] += 0.1 * (x[:, 1] - 0.6 * x[:, 3])
    f[:, 3] += 0.04 * x[:, 3]
    if not jacobian:
        return f
    g = 10000 * diode_is * e / diode_nvt
    j = np.broadcast_to(np.eye(4), (len(x), 4, 4)).copy()
    for i in range(4):
        k = (i + 1) % 4
        j[:, i, i] += g[:, i]
        j[:, k, k] += g[:, i]
        j[:, i, k] -= g[:, i]
        j[:, k, i] -= g[:, i]
    j[:, 1, 1] += 0.1
    j[:, 1, 3] -= 0.06
    j[:, 3, 3] += 0.04
    return f, j


def solve(a, b, diode_is=IS, diode_nvt=NVT):
    """Batch damped Newton; refuse nonconverged points rather than emit a table."""
    a, b = np.broadcast_arrays(np.asarray(a, dtype=float), np.asarray(b, dtype=float))
    shape = a.shape
    a, b = a.ravel(), b.ravel()
    source = np.column_stack((b-a, -b, b+a, -b))
    x = np.zeros_like(source)
    for iteration in range(100):
        f, jac = residual(x, source, diode_is, diode_nvt, True)
        norm = np.max(np.abs(f), axis=1)
        if np.max(norm) < 2e-11:
            break
        dx = np.linalg.solve(jac, -f[..., None])[..., 0]
        alpha = np.minimum(1.0, 0.15 / np.maximum(1e-100, np.max(np.abs(dx), axis=1)))
        for _ in range(30):
            candidate = x + alpha[:, None] * dx
            next_norm = np.max(np.abs(residual(candidate, source, diode_is, diode_nvt)), axis=1)
            good = (next_norm < norm) | (norm < 2e-11)
            if np.all(good):
                x = candidate
                break
            alpha[~good] *= 0.5
        else:
            raise ArithmeticError('Newton line search did not descend')
    else:
        raise ArithmeticError('Newton did not converge')
    norm = np.max(np.abs(residual(x, source, diode_is, diode_nvt)))
    return (1.5 * (x[:, 3]-x[:, 1])).reshape(shape), float(norm/10000), iteration + 1


def interpolate(table, a, b):
    # Match the Rust arithmetic's f32 precision, including signed b restoration.
    a, b = np.asarray(a, np.float32), np.asarray(b, np.float32)
    scale = np.float32((NB-1)/MAX_VOLTS)
    xa = np.clip(a, -MAX_VOLTS, MAX_VOLTS)*scale + np.float32(NB-1)
    xb = np.minimum(np.abs(b), np.float32(MAX_VOLTS))*scale
    ia = np.minimum(xa.astype(np.int64), NA-2)
    ib = np.minimum(xb.astype(np.int64), NB-2)
    fa, fb = xa-ia.astype(np.float32), xb-ib.astype(np.float32)
    p00, p10 = table[ia,ib], table[ia+1,ib]
    p01, p11 = table[ia,ib+1], table[ia+1,ib+1]
    p0, p1 = p00 + fa*(p10-p00), p01 + fa*(p11-p01)
    return np.copysign(np.float32(1),b)*(p0+fb*(p1-p0))


def generate():
    ag = np.linspace(-MAX_VOLTS, MAX_VOLTS, NA)
    bg = np.linspace(0, MAX_VOLTS, NB)
    a, b = np.meshgrid(ag, bg, indexing='ij')
    table, grid_residual, iterations = solve(a, b)
    # Exact zero-axis invariants; do not erase a polarity asymmetry elsewhere.
    table[:,0] = 0.0
    table[NA//2,:] = 0.0
    table32 = table.astype(np.float32)
    # Every cell at 1/4, 1/2, 3/4 in both axes, plus seeded independent random
    # samples across all signs. This is measured coverage, not a formal bound.
    ai, bi = np.meshgrid(np.arange(NA-1), np.arange(NB-1), indexing='ij')
    ae, be = [], []
    for da in [.25,.5,.75]:
        for db in [.25,.5,.75]:
            ae.append(-MAX_VOLTS+(ai.ravel()+da)*2*MAX_VOLTS/(NA-1))
            be.append((bi.ravel()+db)*MAX_VOLTS/(NB-1))
    rng = np.random.default_rng(0xD293032)
    ae.append(rng.uniform(-MAX_VOLTS,MAX_VOLTS,20000))
    be.append(rng.uniform(-MAX_VOLTS,MAX_VOLTS,20000))
    ae,be = np.concatenate(ae),np.concatenate(be)
    truth, validation_residual, _ = solve(ae,be)
    approximation = interpolate(table32,ae,be)
    error = approximation-truth
    assert np.max(np.abs(error)) < 0.0012, 'LUT exceeds checked 1.2mV interpolation ceiling'
    b_flip, _, _ = solve(ae[:8192],-be[:8192])
    a_flip, _, _ = solve(-ae[:8192],be[:8192])
    symmetry_b = np.max(np.abs(b_flip+truth[:8192]))
    asymmetry_a = np.max(np.abs(a_flip+truth[:8192]))
    # Two alternate semiconductor parameter sets bracket the nominal forward
    # curve's unknown part/temperature, without fitting any recordings.
    sensitivity = []
    aa,bb = np.meshgrid(np.linspace(-1.21,1.21,51),np.linspace(-1.21,1.21,51))
    nominal,_,_ = solve(aa,bb)
    for delta in [-.05,.05]:
        changed_is=IS*math.exp(-delta/NVT)
        changed,_,_=solve(aa,bb,changed_is,NVT)
        sensitivity.append({'forward_voltage_shift_v':delta,
                            'max_output_change_v':float(np.max(np.abs(changed-nominal))),
                            'rms_output_change_v':float(np.sqrt(np.mean((changed-nominal)**2)))})
    probes=[(0,.55),(.2234,0),(.2234,.55),(-.2234,.55),(.55,.55),(1.21,.55),(1.21,1.21),(-1.21,1.21)]
    p,_,_=solve(*np.array(probes).T)
    report={'schema':1,'source':'Korg monologue service manual, KLM3621 sheet4',
            'diode_part':'unknown; representative silicon assumption only',
            'diode_is_a':IS,'diode_nvt_v':NVT,
            'grid_shape':[NA,NB],'table_bytes':NA*NB*4,
            'a_domain_v':[-MAX_VOLTS,MAX_VOLTS],'abs_b_domain_v':[0,MAX_VOLTS],
            'engine_unit_volts':VOLTS_PER_UNIT,'table_output':'volts',
            'max_kcl_residual_a':max(grid_residual,validation_residual),
            'grid_newton_iterations':iterations,'validation_points':len(ae),
            'max_measured_interpolation_error_v':float(np.max(np.abs(error))),
            'rms_measured_interpolation_error_v':float(np.sqrt(np.mean(error**2))),
            'worst_error_input_v':[float(ae[np.argmax(np.abs(error))]),float(be[np.argmax(np.abs(error))])],
            'measured_interpolation_ceiling_v':0.0012,
            'interpolation_ceiling_kind':'checked finite coverage, not a mathematical all-real-input certificate',
            'model_inputs':'Published circuit values and assumed silicon curve only; no audio recordings',
            'b_odd_residual_v':float(symmetry_b),'a_non_odd_max_v':float(asymmetry_a),
            'diode_sensitivity':sensitivity,
            'probes':[{'a_v':a,'b_v':b,'output_v':float(v)} for (a,b),v in zip(probes,p)],
            'table_f32_le_sha256':hashlib.sha256(table32.astype('<f4').tobytes()).hexdigest()}
    (HERE/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
    np.save(HERE/'ring_table.npy',table32)
    header=(HERE/'ring_template.rs').read_text()
    rows=[', '.join(f'{x:.9e}' for x in row) for row in table32]
    values='\n'.join('    '+row+',' for row in rows)
    probe_source='\n'.join(f'            ({a:.9f}_f32,{b:.9f}_f32,{v:.9f}_f32),' for (a,b),v in zip(probes,p))
    source=header.replace('// @GENERATED_TABLE@',values).replace('            // @PROBES@',probe_source)
    (HERE/'monologue_ring.rs').write_text(source)
    print(json.dumps(report,indent=2))


if __name__=='__main__':
    generate()
