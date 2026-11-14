# Expedition 73 analysis

The Python package validates and replays NASA POWER / MERRA-2 records for two candidate study windows. It builds monthly regional series, checks compatible inputs and exports source provenance for the web application. The recorded 2001–2024 temperature and precipitation series each contain 288 monthly values per region.

## Set up and run the checks

Use Python 3.12 and Node.js 24 to match CI. Run these commands from the repository root.

**Windows PowerShell**

```powershell
py -3 scripts\workspace.py setup
.\analysis\.venv\Scripts\python.exe scripts\workspace.py check
```

**macOS or Linux**

```sh
python3 scripts/workspace.py setup
analysis/.venv/bin/python scripts/workspace.py check
```

Setup installs pinned dependencies into `analysis/.venv`. The checks use the recorded examples, run the test suites and build the preview. Recorded source replay requires no NASA credentials.

## Replay the regional records

From the `analysis/` directory, run the following commands. For Windows PowerShell, replace `.venv/bin/python` with `.\.venv\Scripts\python.exe`.

```sh
.venv/bin/python -m expedition73 validate-window-history examples/a-history-2001-2024
.venv/bin/python -m expedition73 validate-window-history examples/b-history-2001-2024
.venv/bin/python -m expedition73.precipitation_history examples/precipitation-history-2001-2023
```

The precipitation replay combines the 2001–2023 captures with the recorded 2024 series. For a list of CLI commands, run `-m expedition73 --help` with the same Python interpreter from `analysis/`.

## Data and methods

The recorded commands cover two kinds of input. Point and window replays use different result contracts. The regional browser app uses the window series.

| Operation | CLI or module |
| --- | --- |
| Validate a recorded point result or make a fresh point request | `validate`, `fetch-power-point` |
| Replay or capture a regional rectangle | `validate-window`, `fetch-power-window` |
| Replay or capture a window that spans several requests | `validate-tiled-window`, `fetch-power-tiled-window` |
| Check candidate surface weights and replay the surface workflow | `audit-surface-support`, `run-surface-workflow` |
| Compare annual temperature weighting and replay its dependencies | `validate-annual-weighting`, `run-annual-workflow` |

These commands are exposed by `python -m expedition73`. Use a fresh output directory for new captures. Run a subcommand with --help for command-specific arguments.


- **Temperature.** Monthly 2 m air temperature comes from NASA POWER `T2M`. The area calculation weights each intersecting grid cell by the area it contributes to the candidate rectangle.
- **Precipitation.** NASA POWER `PRECTOTCORR` is represented as a monthly mean daily rate in mm/day. Both regions are evaluated over whole rectangles. Northern Alaska has different observation-based precipitation correction coverage.
- **Surface fractions.** Recorded MERRA‑2 `M2C0NXASM` land, land ice, lake and ocean fractions support temperature weighting experiments.
- **Annual temperature.** The analysis compares equal-month and calendar-day weighting. The reviewer guide describes the slope, approximate confidence intervals and interpretation.

The `examples/` directory holds recorded inputs and outputs, `schemas/` defines result contracts, and `tests/` covers validation and replay. New captures and work products belong in the ignored `analysis/artifacts/` directory. Keep Earthdata credentials in the local ignored `.env`.

[Reviewer guide and source citations](../DEMO.md) · [Web build](../web/README.md)
