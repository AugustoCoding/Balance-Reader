# Balance Reader

[![Pages](https://github.com/AugustoCoding/Balance-Reader/actions/workflows/pages.yml/badge.svg)](https://github.com/AugustoCoding/Balance-Reader/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[Versão em português](README.md)

Data logger for laboratory balances that runs in the browser. The balance is connected to the computer through its serial output (RS232 → USB cable); the page shows the live weight, plots the history, computes a per-reading uncertainty and exports everything to Excel (with chart) or CSV. The interface is in Portuguese, the language of the lab it was built for.

**Open it: <https://augustocoding.github.io/Balance-Reader/>** — nothing to install.

## Using it

Works in desktop **Chrome**, **Edge** or Opera (Windows, macOS, Linux, ChromeOS), which reach the USB port through the [Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API). Firefox, Safari and phones cannot; there only the simulator works.

1. Plug the balance into the computer with the serial-USB cable (install the cable's driver if Windows asks for one).
2. Open the address above and click **Conectar → Escolher porta USB…**. The browser asks for permission once; afterwards the page reconnects by itself, also after the cable is unplugged and plugged back.
3. In **Configurações → Balança** pick the model. If the speed does not match, use **Conexão → Detectar automaticamente**.
4. Click **Iniciar gravação**; when done, **Exportar** → Excel or CSV.

Without a balance, use **Conectar → Usar o simulador**.

### Any balance

Each balance is described by a **profile**: serial parameters, line format and commands (tare, zero, request a reading). Built-in profiles: **BEL LG3202i** (tested on the balance), Mettler Toledo MT-SICS, A&D, Ohaus, Sartorius SBI and a generic one. All but the BEL follow the manufacturers' manuals and **were not tested on real hardware**.

The default parser finds "number + unit" anywhere in a line. A regular-expression mode, stable/unstable/ignore rules, automatic polling, a live line tester and a serial console cover the rest. Profiles can be exported and imported as `.json`.

Everything stays in the browser on that computer (settings and a backup copy of the running session); nothing is sent to any server.

## Development

No build step and no dependencies: plain HTML, CSS and JavaScript modules.

```bash
npm test     # tests (node --test, Node 20+)
npm start    # local server at http://localhost:8080
```

Every push to `main` is tested and deployed to GitHub Pages by [`.github/workflows/pages.yml`](.github/workflows/pages.yml) (first time: *Settings → Pages → Source: GitHub Actions*).

## License

[MIT](LICENSE).
