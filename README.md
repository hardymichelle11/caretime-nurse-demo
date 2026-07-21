# CareTime Nurse — Prototype

A clickable prototype of a nurse-facing functional-needs assessment and ADL care-time estimator.

**[Open the live prototype →](https://hardymichelle11.github.io/caretime-nurse-demo/)**

> **This application provides nursing decision support only. Final assessments and care recommendations remain the responsibility of the licensed nurse.**

---

## Please read before using

**This is a prototype. Do not enter real patient information.**

Every client shown is fictional. The prototype **saves your work in this browser** using `localStorage` so a draft survives a page refresh. That storage is not encrypted, is not a clinical record, and is readable by anyone with access to the device and browser profile. There is no backend and nothing is transmitted anywhere.

To clear a draft, use your browser's "clear site data" for this page.

---

## What it demonstrates

| Screen | Purpose |
| --- | --- |
| Dashboard | Caseload overview and a plain-language summary of how the calculation works |
| Clients | Fictional client directory with search |
| Assessment | Score selection and weekly minute entry for each task, with live totals |
| Results | Care-time breakdown, nurse adjustment with rationale, and sign-off |

### How the calculation works

This prototype implements the **Michigan HCBS Needs Tool / Personal Care Assessment** model:

1. The nurse selects **one score, 1–5**, for each task.
2. That score sets a **maximum minutes per day**.
3. The nurse enters the **actual minutes for each of the seven days**.
4. `weekly minutes = sum of the seven days × tasks per day`

There are no hidden multipliers. Scores 1–2 route to supervision (ECLS); scores 3–5 route to personal care (PCS). One billing unit is 15 minutes.

Every task exposes a **"How this was calculated"** panel showing the selected score, the daily maximum, each day's entry, the formula, the routing rule, and the scoring-matrix version.

### What it deliberately excludes

No cameras, computer vision, motion tracking, wearables, Bluetooth devices, smartwatches, medical-device integrations, automatic gait/balance/range-of-motion measurement, passive monitoring, sensor data, or health-platform integrations. Every finding is entered manually by the nurse.

---

## Status

The scoring matrix is marked `draft-pending-clinical-approval`. It is a faithful transcription of the source instrument, but no clinical stakeholder has ratified it, and several rules remain ambiguous. **No clinical validation is claimed.**

Figures shown do not imply program eligibility, insurance approval, or guaranteed service authorization.

---

## Running locally

The prototype loads its rules over HTTP, so open it through a server rather than as a file:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.

---

## About this repository

This is a **read-only publishing target**. The prototype is developed in a separate private repository and copied here; changes made directly to this repo will be overwritten. Scoring rules live in `data/scoring-rules.json` — no clinical constant is written into the UI code.
