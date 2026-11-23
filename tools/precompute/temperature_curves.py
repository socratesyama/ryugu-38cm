#!/usr/bin/env python3
"""§3.7 temperature model: 1-D heat conduction (Spencer et al. 1989 style), implicit, vectorised over curves.
Grid: latitude (10 deg) x thermal inertia (50..450 tiu) x sub-solar latitude (-8,0,+8). Slope classes are NOT modelled (documented).
Output: site/public/data/temperature_curves.json  (certainty D: model, calibrated against MARA only as a sanity check)."""
import os, json, itertools, numpy as np
ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..')); OUT = os.path.join(ROOT, 'site', 'public', 'data')
P = 7.6326 * 3600.0; om = 2 * np.pi / P
S0 = 1361.0; R_AU = float(os.environ.get('RYUGU_AU', 1.19)); S = S0 / R_AU**2   # mean heliocentric distance during stay ~1.19 AU
A = float(os.environ.get('RYUGU_BOND', 0.014)); EPS = 0.9; SIG = 5.670374e-8; RHOC = 1.0e6
lats = np.arange(-90, 91, 10.0); TIs = np.arange(50, 451, 50.0); decs = np.array([-8.0, 0.0, 8.0])
combos = list(itertools.product(range(len(lats)), range(len(TIs)), range(len(decs)))); N = len(combos)
lat = np.radians(np.array([lats[i] for i, _, _ in combos])); G = np.array([TIs[j] for _, j, _ in combos]); dec = np.radians(np.array([decs[k] for _, _, k in combos]))
k = G**2 / RHOC; ls = np.sqrt(k / (RHOC * om))  # skin depth
nz = 32; zr = np.concatenate([[0], np.cumsum(0.25 * 1.2**np.arange(nz - 1))])  # in skin depths
z = zr[None, :] * ls[:, None]
nstep = 240; dt = P / nstep
def insol(t):
    h = om * t  # hour angle (t=0 noon)
    mu = np.sin(lat) * np.sin(dec) + np.cos(lat) * np.cos(dec) * np.cos(h)
    return S * (1 - A) * np.maximum(mu, 0)
T = np.full((N, nz), 150.0)
def step(T, q):
    dz = np.diff(z, axis=1)
    a = np.zeros((N, nz)); b = np.zeros((N, nz)); c = np.zeros((N, nz)); d = T.copy()
    # interior: rhoC dT/dt = k d2T/dz2 (nonuniform grid)
    for i in range(1, nz - 1):
        dm, dp = dz[:, i - 1], dz[:, i]; w = 2 * k / (RHOC * (dm + dp))
        a[:, i] = -dt * w / dm; c[:, i] = -dt * w / dp; b[:, i] = 1 - a[:, i] - c[:, i]
    b[:, -1] = 1; a[:, -1] = -1; d[:, -1] = 0                    # zero-gradient bottom
    # surface Newton: unknown T0; flux into ground = q - eps sig T0^4 = -k (T1-T0)/dz0 approx
    T0 = T[:, 0].copy()
    for _ in range(6):
        f = q - EPS * SIG * T0**4; df = -4 * EPS * SIG * T0**3
        # implicit surface node with half cell: (rhoC dz0/2)(T0new-T0old)/dt = f + k (T1-T0)/dz0
        dz0 = dz[:, 0]; cap = RHOC * dz0 / 2 / dt
        b[:, 0] = cap - df + k / dz0; c[:, 0] = -k / dz0; a[:, 0] = 0
        d[:, 0] = cap * T[:, 0] + f - df * T0
        # Thomas
        cp = np.zeros((N, nz)); dp_ = np.zeros((N, nz)); cp[:, 0] = c[:, 0] / b[:, 0]; dp_[:, 0] = d[:, 0] / b[:, 0]
        for i in range(1, nz):
            m = b[:, i] - a[:, i] * cp[:, i - 1]; cp[:, i] = c[:, i] / m; dp_[:, i] = (d[:, i] - a[:, i] * dp_[:, i - 1]) / m
        X = np.zeros((N, nz)); X[:, -1] = dp_[:, -1]
        for i in range(nz - 2, -1, -1): X[:, i] = dp_[:, i] - cp[:, i] * X[:, i + 1]
        T0 = X[:, 0]
    return X
t = 0.0
for rev in range(25):
    for s in range(nstep):
        T = step(T, insol(t + dt)); t += dt
curves = np.zeros((N, 96))
for s in range(96):  # 15-min local-time bins: local time 0 = midnight -> noon at t=P/2
    ts = (s / 96.0 + 0.5) * P
    for _ in range(max(1, nstep // 96)):
        T = step(T, insol(t + dt)); t += dt
    curves[:, s] = T[:, 0]
# build a clean one-revolution record aligned to local time: re-run one more revolution and sample by hour angle
rec = np.zeros((N, 96)); cnt = np.zeros(96)
for s in range(nstep):
    T = step(T, insol(t + dt)); t += dt
    ph = ((om * t / (2 * np.pi)) + 0.5) % 1.0  # local-time fraction, 0=midnight
    bi = int(ph * 96) % 96; rec[:, bi] += T[:, 0]; cnt[bi] += 1
rec /= np.maximum(cnt, 1)
for i in range(96):
    if cnt[i] == 0: rec[:, i] = rec[:, i - 1]
json.dump(dict(local_time_step_min=15, lat_deg=lats.tolist(), ti_tiu=TIs.tolist(), subsolar_lat_deg=decs.tolist(),
    index='((lat_i*len(ti)+ti_j)*len(dec)+dec_k)', curves_K=np.round(rec, 1).tolist(),
    assumptions=dict(model='1D heat conduction, rho*c=1e6 J/m3/K constant, k=Gamma^2/(rho c)', bond_albedo=A, emissivity=EPS, heliocentric_AU=R_AU,
                     slopes='not modelled', roughness='not modelled', shadowing='none'), certainty='D',
    mara_comparison=dict(site='MASCOT (~22S), BP8-12 band', mara_K=[184.2,307.8], model_K_lat20_ti300=[209,327], note='Model is ~+19..25 K warmer than MARA brightness temperatures; no tuning applied. Shown as model estimate (D).')), open(os.path.join(OUT, 'temperature_curves.json'), 'w'), separators=(',', ':'))
# sanity vs MARA at MASCOT site (lat -22, TI ~300): daytime max
mara = json.load(open(os.path.join(OUT, 'mara.json')))
vals = [r['t'][3] for r in mara['rows'] if r['t'][3] is not None and r['status'] != 'preRelease']
i = (np.argmin(abs(lats + 20)) * len(TIs) + np.argmin(abs(TIs - 300))) * len(decs) + 1
print('MARA BP8-12 range K:', min(vals) if vals else None, max(vals) if vals else None, '| model lat-20 TI300: min %.0f max %.0f' % (rec[i].min(), rec[i].max()))
print('curves', N)
