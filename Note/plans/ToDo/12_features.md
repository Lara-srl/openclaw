features 1 — SHUTDOWN (Dormo) non visibile: long-press spegne subito

Causa: nel firmware (sensecap_watcher.cc:282-292), BUTTON_LONG_PRESS_START chiama direttamente IoExpanderSetLevel(BSP_PWR_SYSTEM, 0) — spegnimento istantaneo, zero UI.

Fix firmware:

1. Long-press → AdaUiManager::SetState(900) → mostra "Dormo" + animazione occhi che si chiudono
2. Timer ESP di 1.5s
3. Solo dopo il timer → esp_deep_sleep_start()

Serve anche configurare il wakeup (esp_sleep_enable_ext0_wakeup) per riaccendere con il bottone.

---

features 2 — Cambiare colore occhi a runtime via voce

Fattibile! Servono due pezzi:

1. Nuovo tool Ada (laragoci_eyes_color) che accetta un colore hex e lo manda al device via MCP, tipo:
   bridge.callDeviceMcp("tools/call", { name: "self.led.set", arguments: { hex_color: "#00FF00" } })
1. Oppure un comando SET_UI custom con un campo eye_color.
1. Firmware: screen_state deve supportare un parametro colore per i cerchi degli occhi (attualmente probabilmente hardcoded bianco). Basta che AdaUiManager esponga un SetEyeColor(lv_color_t) che aggiorna
   lv_obj_set_style_bg_color() sui due oggetti occhio.

L'utente direbbe: "Ada cambia il colore degli occhi in verde" → il Pi agent chiama il tool → il device aggiorna.

---

features 3
3 Scatta una foto deve comparirre sullo schermo

## Step 7 — 2.3: Bluetooth A2DP Sink

**Obiettivo**: streaming audio TTS verso cuffie BT. Quando BT è connesso, sostituisce lo speaker interno.

### Architettura

- **A2DP Sink**: device riceve comandi di pairing, diventa ricevitore audio
- **Routing**: quando BT paired → audio va a BT; quando non paired → speaker interno
- **Ring buffer**: 200ms a 44100Hz stereo int16 = ~35KB (allocare in PSRAM)

### Task Management FreeRTOS

- `Task_Audio_BT`: priorità 22 (massima), gestisce il buffer audio verso le cuffie
- `Task_Comm_WiFi`: priorità standard, gestisce lo scambio dati con il cloud

### Coesistenza WiFi+BT

- ESP32-S3: antenna condivisa, time-division automatico via `esp_wifi_bt_coex_config`
- WiFi: `WIFI_PS_MIN_MODEM` (non `WIFI_PS_NONE`) per coesistenza
- Buffer 200ms copre gap DTIM (~100ms) con margine 2x

### Conversione audio

- Pipeline attuale: Opus 24kHz mono → PCM int16
- A2DP richiede: 44100Hz stereo int16
- `BtAudioSink::WritePcm()` fa resample + stereo duplicate

### File da creare

- `Note/main/audio/bt_audio_sink.h` + `bt_audio_sink.cc`

### Config

- `sdkconfig`: `CONFIG_BT_ENABLED=y`, `CONFIG_BT_CLASSIC_ENABLED=y`, `CONFIG_BT_A2DP_ENABLE=y`
- Gated dietro `CONFIG_ADA_BT_A2DP` Kconfig option (compilabile out)

### File da modificare

- `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` — init BT nel costruttore
- `Note/main/CMakeLists.txt` — aggiungere bt_audio_sink.cc + componenti IDF `bt`, `bluedroid`
- `Note/main/Kconfig.projbuild` — opzione `CONFIG_ADA_BT_A2DP`

### Verifica

- Pairing cuffie BT con device
- Conversazione vocale → audio esce dalle cuffie
- WiFi stabile durante streaming BT (no disconnessioni WS)

**Complessità: XL** (massimo rischio, richiede test hardware estensivo)

---

## Rischi e mitigazioni

| Rischio                                  | Impatto           | Mitigazione                                 |
| ---------------------------------------- | ----------------- | ------------------------------------------- |
| LVGL thread safety (SetState da task WS) | Crash             | Usare `lv_async_call()` esclusivamente      |
| Display 412x412 vs 320x320 nel doc       | Layout sbagliato  | Corretto in questo piano                    |
| BT+WiFi glitch audio                     | Scatti audio      | Buffer 400ms se 200ms insufficiente         |
| Camera JPEG troppo grande per MCP reply  | Send fallisce     | Verificare WS buffer ≥128KB                 |
| Deep sleep wakeup via IO expander        | Non si riaccende  | Usare INT pin (GPIO_NUM_2) come ext0 wakeup |
| `PlaySound()` haptic asincrono           | Suoni sovrapposti | Flag `haptic_busy` in fase 3 se necessario  |
| Camera timeout MCP                       | Tool fallisce     | Timeout 10s per `laragoci_photo`            |

---

## File di riferimento (repo-relative)

### Esistenti (da modificare)

- `extensions/xiaozhi/src/protocol.ts`
- `extensions/xiaozhi/src/audio-pipeline.ts`
- `extensions/xiaozhi/src/bridge.ts`
- `extensions/xiaozhi/src/tools.ts`
- `extensions/xiaozhi/src/types.ts`
- `extensions/xiaozhi/src/context-manager.ts`

### Firmware reference (in Note/main/)

- `Note/main/protocols/websocket_protocol.cc`
- `Note/main/boards/sensecap-watcher/sensecap_watcher.cc`
- `Note/main/mcp_server.h/.cc`
- `Note/main/led/single_led.h`
- `Note/main/display/lcd_display.cc`
- `Note/main/device_state_machine.h/.cc`

### Da creare

- `extensions/xiaozhi/src/ui-state.ts`
- `extensions/xiaozhi/src/ui-state.test.ts`
- `Note/main/display/ada_ui_manager.h/.cc` (firmware ref)
- `Note/main/display/assets/` (C-array images)
- `Note/main/audio/bt_audio_sink.h/.cc` (firmware ref)
