# Recorded NASA surface fraction subsets

`a-surface-fractions/` and `b-surface-fractions/` contain regional subsets retrieved from NASA OPeNDAP on October 18, 2026. The Colorado area subset contains 56 source cells and the Northern Alaska subset contains 55. Both come from NASA GMAO / GES DISC MERRA-2 **M2C0NXASM 5.12.4** (`const_2d_asm_Nx`). [Dataset DOI](https://doi.org/10.5067/ME5QX6Q5IGGU) · [NASA citation guidance](https://gmao.gsfc.nasa.gov/gmao-products/merra-2/citing-merra-2-data_merra-2/)

Each subset records the request, NetCDF response, source metadata, normalized fractions and conversion report. The replay uses these five files without contacting NASA or requiring credentials.

`a-surface-sensitivity.json` and `b-surface-sensitivity.json` record how alternative surface weights affect the 2024 NASA POWER 2 m air temperature means. The calculation uses grid-cell air temperatures and assumes a uniform surface fraction within each cell. The results describe sensitivity to candidate weights.

`.gitattributes` preserves the recorded file bytes across operating systems for SHA-256 verification.

Run the offline replay from the `analysis/` directory. These examples use Windows Command Prompt.

```cmd
.venv\Scripts\python.exe scripts/fetch_surface_fractions.py --replay examples/a-surface-fractions
.venv\Scripts\python.exe scripts/fetch_surface_fractions.py --replay examples/b-surface-fractions
.venv\Scripts\python.exe -m expedition73 run-surface-workflow --window-run examples/b-window-2024 --fraction-run examples/b-surface-fractions --output-dir artifacts/b-surface-new-run
```

On macOS or Linux, use `.venv/bin/python` for each command. Install the analysis dependencies before replaying the subsets. [Analysis setup](../README.md#set-up-and-run-the-checks)
