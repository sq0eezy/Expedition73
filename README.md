# Expedition 73

Expedition 73 is a climate data explorer developed around a NASA Space Apps challenge. Compare 2 m air temperature and precipitation in two candidate regions, the Colorado area and Northern Alaska, using NASA POWER / MERRA-2 records from 2001 to 2024.

[Live demo](https://sq0eezy.github.io/Expedition73/) · [Reviewer guide](DEMO.md) · [NASA Space Apps challenge](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/)

Project team: Emeç Yıldız and Ege Kıray. This repository contains an imported snapshot of the existing Expedition 73 project.

## What you can explore

- Compare monthly temperatures, regional differences and the full 288-month record.
- Inspect annual trends and approximate 95% confidence intervals for both indicators, with a paired regional difference for temperature.
- Explore monthly precipitation rates and the joint seasonal profile.
- Locate the study windows on a globe and inspect the recorded calculation workflow and data sources.

The two study windows are fixed candidate rectangles. The trend results and the precipitation coverage limits are explained in the [reviewer guide](DEMO.md).

## Run locally

Use Python 3.12, the version used in CI. From the repository root, run the launcher for your platform and open the preview in your browser. Press Ctrl+C to stop the server.

| Platform | Command |
| --- | --- |
| Windows | `scripts\start-preview.cmd` |
| macOS or Linux | `sh scripts/start-preview.sh` |

[Local preview](http://127.0.0.1:8873/) · [Web build and Docker instructions](web/README.md)

## Repository layout

| Path | Purpose |
| --- | --- |
| [`web/`](web/README.md) | Browser application, preview and demo packaging |
| [`analysis/`](analysis/README.md) | NASA source replay, regional calculations and validation |

The GitHub Pages workflow publishes the application from `main`. [Deployment workflow](.github/workflows/portal-pages.yml)
