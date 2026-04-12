# 02 — Setup Device ESP32-S3-BOX-3

_Data: 2026-03-14 — Aggiornato: 2026-03-19 (P3 completato — handshake WS funzionante)_

## Prerequisiti

- [x] Task 1.2 + 1.3 + 1.4 bridge WS funzionante ✅ 2026-03-14
- [x] SSL/TLS `laragoci.lara-ai.eu` via Cloudflare Tunnel ✅

---

## ⚠️ Nota critica — URL WebSocket è compile-time

L'URL del server WebSocket (e l'URL OTA) **non è configurabile a runtime**.
È compilato nel firmware nel file `main/Kconfig.projbuild`.

Il firmware pre-compilato punta sempre a:

```
OTA:  https://api.tenclass.net/xiaozhi/ota/
WSS:  wss://api.tenclass.net/xiaozhi/v1/
```

Per puntare al nostro gateway occorre **ricompilare il firmware da sorgente** (Fase B).

---

## Fase A — Validazione hardware (senza compilare)

**Stato 2026-03-16:** ✅ SALTATA — hardware già verificato funzionante (loghi visibili, device risponde).

### A1 — Driver USB su Windows ✅

- Driver installato: **CP2102** (Silicon Labs CP210x_VCP_Windows.zip)
- Device visibile in Gestione dispositivi → Porte (COM e LPT) → **COM8**
- Parametri: 9600 baud, 8 bit dati, parità nessuna (normale — il flash usa baud diverso)

### A2 — Flash firmware pre-compilato

> ⚠️ `https://xiaozhi.me/flash` restituisce 404 — non disponibile.
> Usare direttamente Fase B (compilazione da sorgente).

### A3 — Configura WiFi

Al primo avvio il BOX-3 crea un AP temporaneo:

1. Il device mostra sul display un SSID tipo **`XiaoZhi-XXXXXX`**
2. Connetti il telefono (o PC) a quell'AP
3. Apri browser → `http://192.168.4.1`
4. Seleziona la tua rete **2.4 GHz** (il 5 GHz non è supportato) e inserisci la password
5. Il device si riconnette e mostra l'IP sul display

---

## Fase B — Firmware custom per OpenClaw (ricompilazione)

Obiettivo: puntare il device a `laragoci.lara-ai.eu` invece del server pubblico.

### B1 — Ambiente di sviluppo

**Stato 2026-03-17:** ✅ Driver CP2102 installato, BOX-3 visibile su **COM8**.
ESP-IDF **v5.4.3** installato via EIM GUI ✅. Path: `C:\esp`.
Ambiente Python configurato con **Python 3.12.9** ✅ (`idf5.4_py3.12_env`).
XiaoZhi clonato in `C:\esp\xiaozhi-esp32` ✅.

⚠️ **Blocco 2026-03-17:** XiaoZhi richiede **ESP-IDF ≥5.5.2** — la v5.4.3 non basta.
Errore: `no versions of idf match >=5.5.2` durante `idf.py set-target esp32s3`.

**Prossimo step:** installare **v5.5.3** via EIM GUI:

```powershell
C:\Users\francesco.marchesini\.espressif\eim_gui\eim-gui-windows-x64.exe
```

Expert Install → ESP32-S3 → **v5.5.3** → mirror default → no features → tools default → `C:\esp`
Installerà in `C:\esp\v5.5.3\` affiancato a v5.4.3.

Poi attivare con:

```powershell
$env:PATH = (py -3.12 -c "import sys, os; print(os.path.dirname(sys.executable))") + ";" + $env:PATH
. C:\esp\v5.5.3\esp-idf\export.ps1
```

E riprendere da `idf.py set-target esp32s3`.

**ESP-IDF Installation Manager (EIM GUI):**

- Eseguibile: `C:\Users\francesco.marchesini\.espressif\eim_gui\eim-gui-windows-x64.exe`
- Si avvia automaticamente dall'estensione VS Code v2.x (sostituisce il vecchio wizard interno)
- Documentazione ufficiale: https://docs.espressif.com/projects/idf-im-ui/en/latest/

#### Wizard EIM GUI — Welcome screen (4 opzioni)

All'avvio compare una schermata con 4 scelte:

1. **Simplified Installation** — setup rapido con impostazioni default ✅ (consigliato)
2. **Expert Installation** — controllo completo, 5 step
3. **Load Configuration** — importa file `.toml` pre-configurato
4. **Offline Installation** — appare solo se c'è un archivio `.zst` nella cartella dell'installer

#### Simplified Installation (3-5 step)

1. Selezione modalità → clicca "Simplified Installation"
2. Verifica automatica prerequisiti e path
3. Conferma impostazioni rilevate automaticamente
4. Esecuzione installazione (progress bar + log espandibile)
5. Completamento — ambiente pronto, integrazione VS Code abilitata

#### Expert Installation (5 step)

1. **Target** — scegli chip target (default: tutti)
2. **IDF Version** — seleziona versione (scegliere **v5.4.x**)
3. **Download Mirrors** — mirror di download (default OK per Italia)
4. **Tools** — strumenti da installare (accetta default; **non** richiede esp-clang manuale)
5. **Path** — `C:\esp` (default Windows) ✅

#### Impostazioni raccomandate per XiaoZhi

| Impostazione | Valore                                     |
| ------------ | ------------------------------------------ |
| Modalità     | Simplified (o Expert se serve path custom) |
| IDF Version  | **v5.4.x**                                 |
| Path         | `C:\esp` (default)                         |
| IDE Support  | abilitato automatico                       |

1. Installa **VS Code**: https://code.visualstudio.com/
2. Installa l'estensione **Espressif IDF** dal marketplace VS Code (cerca `espressif`)
   - Versione installata: **2.0.2**
3. Apri Command Palette (`Ctrl+Shift+P`) → cerca `ESP-IDF: Configure ESP-IDF Extension`
   - ⚠️ Con v2.x il comando potrebbe non apparire subito — vedi B1-TS
4. Segui il wizard **Express**: scarica ESP-IDF **v5.4.x** (obbligatorio, 5.3.x non compila XiaoZhi)
5. Path consigliati: IDF → `C:\esp\esp-idf`, Tools → `C:\esp\tools`
6. **Non selezionare** `esp-clang` né `sdkconfig for coverage` — usare il default GCC
7. Attendi ~15-20 min (circa 1.5 GB download)

> **Nota:** su Windows evita path con spazi o caratteri speciali.

#### B1-TS — Troubleshooting setup wizard ESP-IDF v2.x ✅ RISOLTO

Con l'estensione v2.0.2 il comando `ESP-IDF: Configure ESP-IDF Extension` non appare
nel Command Palette. Comandi visibili attualmente:

- `ESP-IDF: SDK project sdkconfig for coverage`
- `ESP-IDF: project for esp-clang`
- `ESP-IDF: dispose of current SDK configuration editor server process`
- `ESP-IDF: SDK configure edit`
- `ESP-IDF: add arduino esp32 as esp-idf component`
- `ESP-IDF: clear esp-idf search result`
- `ESP-IDF: create new esp-idf component`
- Nella sidebar sinistra: **New Wizard Project** e **Create New Component**

**Soluzione adottata:**

- Usato **EIM GUI** (`eim-gui-windows-x64.exe`) — si avvia dalla sidebar VS Code → New Wizard Project
- Expert Install → ESP32-S3 → v5.4.3 → mirror default → no features → tools default → `C:\esp`
- Errore download `esp-clang`: scaricato manualmente da GitHub e posizionato in `C:\Espressif\tools\esp-clang\esp-18.1.2_20240912\esp-clang\`
- Errore Python 3.14 (`windows-curses` non disponibile su Win): installato **Python 3.12.9**, poi:
  ```powershell
  Remove-Item -Recurse -Force "C:\Users\francesco.marchesini\.espressif\python_env\idf5.4_py3.14_env"
  py -3.12 C:\esp\v5.4.3\esp-idf\tools\idf_tools.py install-python-env
  ```
- Attivazione ambiente (Python 3.14 presente nel sistema → forzare 3.12 prima):
  ```powershell
  $env:PATH = (py -3.12 -c "import sys, os; print(os.path.dirname(sys.executable))") + ";" + $env:PATH
  . C:\esp\v5.4.3\esp-idf\export.ps1
  ```
  Output atteso: `Done! You can now compile ESP-IDF projects.`

> **Nota:** VS Code non è necessario per compilare/flashare. Usa l'**ESP-IDF PowerShell** (menu Start → "ESP-IDF PowerShell") — ambiente già configurato. VS Code utile solo per editare sorgenti.

### B2 — Clone sorgente XiaoZhi

```powershell
git clone https://github.com/78/xiaozhi-esp32.git C:\esp\xiaozhi-esp32
cd C:\esp\xiaozhi-esp32
```

### B3 — Configura target e URL

Nel terminale ESP-IDF (`Ctrl+Shift+P` → `ESP-IDF: Open ESP-IDF Terminal`):

```powershell
idf.py set-target esp32s3
idf.py menuconfig
```

In `menuconfig` navigare con frecce, `Enter` per entrare, `Esc` per tornare, `S` per salvare, `Q` per uscire:

```
Xiaozhi Assistant Configuration
  ├── Board Type        → ESP_BOX_3
  ├── Connection Type   → Websocket
  ├── OTA Server URL    → https://laragoci.lara-ai.eu/xiaozhi/ota/
  └── Websocket URL     → wss://laragoci.lara-ai.eu/xiaozhi/v1/
```

### B4 — Compila

```powershell
idf.py build
```

Circa 5-15 minuti alla prima build. Le successive sono più rapide.

### B5 — Flash

```powershell
# COM8 è la porta rilevata in A1
idf.py -p COM8 -b 2000000 flash monitor
```

Il `monitor` apre il log seriale in tempo reale (utile per debug).
Esci dal monitor: `Ctrl+]`

### B6 — Test handshake con OpenClaw

1. Assicurati che il gateway OpenClaw sia in esecuzione sulla VM:
   ```bash
   # Su VM Hetzner
   tail -n 50 /tmp/openclaw-gateway.log
   ```
2. Accendi il BOX-3 (o riavvia)
3. Nel log gateway verificare:
   ```
   [xiaozhi] device connected: <device-id>
   [xiaozhi] hello received, session_id assigned
   ```
4. Sul display del BOX-3 deve apparire l'emoji di idle (es. 😐)

---

## Step successivo dopo handshake OK

- Fase 2 audio pipeline (task 2.1→2.7): Opus decode, VAD, Whisper STT, TTS
- Dettagli in `Note/road_map_laragoci.md`

---

## Riferimenti

- Firmware XiaoZhi: https://github.com/78/xiaozhi-esp32
- Releases (merged-binary): https://github.com/78/xiaozhi-esp32/releases
- Protocollo WS: https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md
- Driver CP2102 (Windows): https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers
- ESP-IDF installer Windows: https://dl.espressif.com/dl/esp-idf/?idf=5.4
- ESP-IDF extension releases: https://github.com/espressif/vscode-esp-idf-extension/releases
- OTA endpoint: `extensions/xiaozhi/src/ota.ts`
