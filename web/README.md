# Expedition 73 web application

The browser app compares recorded NASA POWER / MERRA-2 temperature and precipitation for the Colorado area and Northern Alaska. The static preview is built from checked-in source records and runs locally in the browser. [Live demo](https://sq0eezy.github.io/Expedition73/) · [Reviewer walkthrough](../DEMO.md)

## Local preview

From the repository root, run `scripts\start-preview.cmd` on Windows or `sh scripts/start-preview.sh` on macOS and Linux. The launchers create the analysis environment when needed, build the preview and start a server on port 8873. Press Ctrl+C to stop it. Pass `--port 8874` to use another port. [Local preview](http://127.0.0.1:8873/)

With the analysis environment already installed, the commands below are equivalent to the build and serve steps.

**Windows PowerShell**

```powershell
.\analysis\.venv\Scripts\python.exe analysis\scripts\build_web_preview.py
.\analysis\.venv\Scripts\python.exe web\serve.py
```

**macOS or Linux**

```sh
analysis/.venv/bin/python analysis/scripts/build_web_preview.py
analysis/.venv/bin/python web/serve.py
```

**Docker**

```sh
docker compose --env-file docker/compose.env up --build
docker compose --env-file docker/compose.env down
```

Run the second Docker command after stopping the preview to remove its containers. The published preview port binds to localhost.

## Build, package and verify

The builder replays the recorded source data before writing public assets to `web/dist/`. From the repository root, run the commands below with the analysis environment. On Windows, replace `analysis/.venv/bin/python` with `.\analysis\.venv\Scripts\python.exe`.

```sh
analysis/.venv/bin/python scripts/workspace.py package
analysis/.venv/bin/python scripts/workspace.py verify-package web/artifacts/expedition73-preview.zip
```

The ZIP contains the public browser assets, recorded results and a SHA-256 manifest. See the reviewer guide for serving an extracted copy. [Offline demo instructions](../DEMO.md#open-the-demo)

## Developer checks

Run `scripts/workspace.py check` with the analysis environment to replay the recorded examples, run the Python and JavaScript suites and build the preview. The JavaScript checks use Node.js 24 in CI.

For browser QA with a local server running, run `node web/tests/dashboard.cjs` and `node web/tests/indicators.cjs`. These suites use Playwright with installed Chrome by default. Set `EXPEDITION73_PLAYWRIGHT` to the package directory if installed separately and `EXPEDITION73_BROWSER=msedge` to use Edge. Test screenshots go under `web/artifacts/`.

`web/src/` contains the HTML, CSS and browser modules. The JSON configuration in `web/` selects recorded inputs for the builder. The GitHub Pages workflow stages the built application. [Deployment workflow](../.github/workflows/portal-pages.yml)
