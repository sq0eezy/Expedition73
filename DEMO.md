# Expedition 73 demo guide

Expedition 73 lets reviewers compare recorded climate indicators for two candidate regions, the Colorado area and Northern Alaska. The temperature and precipitation records cover January 2001 through December 2024.

## Open the demo

Open the [live Expedition 73 showcase](https://sq0eezy.github.io/Expedition73/) in your browser. The temperature-trend view is also available in the local build and the updated offline ZIP.

From the repository root, run `.\scripts\start-preview.cmd` on Windows or `sh scripts/start-preview.sh` on macOS and Linux. Open [the local demo](http://127.0.0.1:8873/) in your browser.

To use the standalone demo ZIP, extract it into a new empty folder and run the following command from that folder. Use `py -3` on Windows or `python3` on macOS and Linux if `python` is unavailable.

```sh
python -c "from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer; SimpleHTTPRequestHandler.extensions_map.update({'.mjs': 'text/javascript', '.webm': 'video/webm'}); ThreadingHTTPServer(('127.0.0.1', 8873), SimpleHTTPRequestHandler).serve_forever()"
```

Open [the local demo](http://127.0.0.1:8873/) and stop the server with Ctrl+C when finished. The packaged demo reads its data from the extracted folder.

## Walk through the results

In **Compare → Selected year**, use **Copy comparison link** in the filters to share the current year, month, regions, surface weighting and subtraction order. On a phone, open **Filters** first. The recipient opens the same selection using the data published at that address.

1. Open **Compare → Trends** with both regions selected. For **2 m air temperature**, **Season** defaults to **Annual** (2001–2024, 24 years), where the fitted slopes are **+0.29 °C per decade** for the Colorado area (approximate 95% CI **−0.07 to +0.65**) and **+0.41 °C per decade** for Northern Alaska (**−0.17 to +0.98**). The paired A−B difference is **−0.12 °C per decade** (**−0.75 to +0.51**). **Series** defaults to **Annual values**; switch **Series** to **Temperature anomalies** to plot both regions in °C on a shared vertical scale with a zero reference line (**Relative to each region’s 2001–2010 mean**). Switch **Season** to **Summer (Jun–Aug)** or **Winter (Dec–Feb)** to inspect seasonal trends over the common **2002–2024** period (23 complete seasons): for **Summer (Jun–Aug)**, the slopes are **+0.38 °C per decade** (**−0.21 to +0.98**) in the Colorado area, **−0.04 °C per decade** (**−0.62 to +0.55**) in Northern Alaska, and **+0.42 °C per decade** (**−0.64 to +1.48**) for A−B; for **Winter (Dec–Feb)**, the slopes are **+0.31 °C per decade** (**−0.29 to +0.91**) in the Colorado area, **+0.17 °C per decade** (**−1.41 to +1.75**) in Northern Alaska, and **+0.14 °C per decade** (**−1.30 to +1.59**) for A−B. Select **Precipitation rate** to see the Colorado area slope of **−0.030 (mm/day) per decade** (**−0.144 to +0.084**) and Northern Alaska slope of **+0.093 (mm/day) per decade** (**−0.016 to +0.202**). Every interval includes zero. **View annual time series** shows the recorded annual or seasonal values, temperature anomalies and fitted lines.
2. Open **Compare → Selected year**, select **July 2024**, and keep **Whole region · unmasked** selected. The regional means are **26.523 °C** and **9.697 °C**. The displayed difference is **16.825 °C**, calculated before rounding. **Full record** shows all 288 months per region.
3. Open **Indicators → Seasonal profile** for the joint seasonal view. June through August were the three warmest months in both candidate regions in 2024. Their day-weighted precipitation rates were **1.02 mm/day** in the Colorado area and **3.30 mm/day** in Northern Alaska. **Precipitation record** explains the high-latitude coverage caveat.
4. Open **Indicators → Weather globe** to locate the study windows, or **Indicators → Workflow & export** to inspect the recorded 2024 workflow and download the indicator data. **Data and methods** provides the temperature source and weighting details.

## Interpret the results

In **Compare → Trends**, choose one of the two **Try an investigation** buttons at the top of the screen. The answer appears directly below the questions, followed by the regional estimates and approximate 95% intervals. Open **View annual time series** for the chart, **View annual values** for the CSV, and **Method and limitations** for the source assumptions and statistical method.

In **Compare → Trends**, open **View annual values** to inspect the 24 annual means used to fit each selected region's slope. The CSV download includes the same regions, with units in the column headings and values at calculation precision. Its values describe the whole, unmasked study windows.

When **Series** is set to **Temperature anomalies** (available in the **Annual** temperature view), each region uses **2001–2010** as the project reference period. From the verified calendar-day-weighted annual means $T_{r,y}$, the regional reference mean is $\bar{T}_{r,2001\text{--}2010} = \frac{1}{10}\sum_{y=2001}^{2010} T_{r,y}$ (**10.865772 °C** for the Colorado area and **−9.047106 °C** for Northern Alaska), and each annual anomaly is $A_{r,y} = T_{r,y} - \bar{T}_{r,2001\text{--}2010}$ in °C. **View annual time series**, **View annual values** and the anomaly CSV (`expedition73-temperature-anomalies-2001-2024-ref-2001-2010.csv`) display these anomalies; if any 2001–2010 reference year is missing for a series, anomalies are not computed for that series.

When **Season** is set to **Summer (Jun–Aug)** or **Winter (Dec–Feb)**, each seasonal mean uses the verified unmasked monthly temperatures weighted by calendar days when all three months of that season are present, without imputing missing months. **Summer (Jun–Aug)** combines June (30 days), July (31 days) and August (31 days) of year $y$. **Winter (Dec–Feb)** is assigned to the year of January and February, combining December of year $y-1$ (31 days) with January (31 days) and February (28 or 29 days in leap years) of year $y$ (for example, Winter 2002 covers December 2001–February 2002). Because December 2000 is outside the 2001–2024 monthly record, both seasonal views use the common **2002–2024** period (23 years) and download season-specific CSV files (`expedition73-temperature-summer-jun-aug-means-2002-2024.csv` and `expedition73-temperature-winter-dec-feb-means-2002-2024.csv`). Separate 95% confidence intervals for summer and winter describe uncertainty within each season and do not test whether the two seasonal slopes differ significantly.

The candidate trends use 24 complete calendar years per unmasked rectangle. Calendar-day weighting converts monthly values to annual means in °C for temperature and mm/day for precipitation rate. Approximate 95% intervals use Newey–West standard errors with two annual lags and a small-sample adjustment. The paired temperature contrast fits the annual A−B series. Precipitation slopes are evaluated separately because Northern Alaska falls above the latitude limit for MERRA-2's observation-based correction over land. The results are sensitive to the model and period. The intervals address uncertainty under the fitted model. [Temperature verification tests](web/tests/comparison.test.mjs) · [NASA MERRA-2 precipitation correction](https://gmao.gsfc.nasa.gov/pubs/docs/Bosilovich803.pdf)

## Project-page draft

Expedition 73 is an interactive NASA data explorer for comparing climate records in the Colorado area and Northern Alaska. Users choose an indicator and study window, plot annual means from 288 monthly records per region and inspect linear slopes with approximate 95% confidence intervals. Over 2001–2024, the temperature slopes are positive in both windows. The mean daily precipitation rate has a negative fitted slope in the Colorado area and a positive one in Northern Alaska. All four regional intervals and the paired temperature interval include zero. A globe locates the study windows, and the workflow view traces the source data.

## Data, media and licenses

- **Temperature and precipitation.** NASA Langley Research Center's POWER Project supplies `T2M` and `PRECTOTCORR` from NASA GMAO MERRA-2. The precipitation values are monthly means of daily rates in mm/day. Northern Alaska lies above the latitude limit for MERRA-2 observation-based precipitation correction over land. [NASA POWER monthly API](https://power.larc.nasa.gov/docs/services/api/temporal/monthly/) · [NASA MERRA-2 precipitation correction](https://gmao.gsfc.nasa.gov/pubs/docs/Bosilovich803.pdf)
- **Surface fractions.** NASA GES DISC MERRA-2 `M2C0NXASM` version `5.12.4` supplies land, ice, lake and ocean fractions for the alternative surface-weighting views. [Collection and granule](https://cmr.earthdata.nasa.gov/virtual-directory/collections/C1276812819-GES_DISC/temporal)
- **Globe basemap and storm video.** Credit NASA Earth Observatory for the July 2004 Blue Marble topography mosaic, and NASA's Scientific Visualization Studio for the Hurricane Arthur visualization using NASA/JAXA GPM data. The storm video is a separate recorded example. [Blue Marble](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography/) · [Hurricane Arthur](https://svs.gsfc.nasa.gov/4186/) · [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)
- **Statistical method.** Whitney K. Newey and Kenneth D. West's heteroskedasticity and autocorrelation consistent covariance estimator. [Method reference](https://www.nber.org/papers/t0055)
- **Repository code.** The team is confirming the license for the original application code. [2026 participant terms](https://www.spaceappschallenge.org/legal/)
- **Build tooling.** The standalone ZIP contains the browser files, recorded results and media. For source builds, NumPy carries BSD-3-Clause and bundled-component notices, netCDF4 and jsonschema are MIT. Pinned packages are recorded in the [analysis lockfile](docker/requirements.lock).

## Rebuild the ZIP

With the repository's analysis environment ready, run `scripts/workspace.py package --output web/artifacts/expedition73-submission-demo.zip` and `scripts/workspace.py verify-package web/artifacts/expedition73-submission-demo.zip` with `analysis\.venv\Scripts\python.exe` on Windows or `analysis/.venv/bin/python` on macOS and Linux. The verifier checks the public file list and the SHA-256 manifest.
