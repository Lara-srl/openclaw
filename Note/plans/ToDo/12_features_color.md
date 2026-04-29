# Feature: Colore occhi Ada a runtime

**Data inizio:** 2026-04-23
**Stato:** Parte 1 completata, Parte 2 in debug

---

## Parte 1 — Server TypeScript ✅ COMPLETATO

### 1.1 `extensions/xiaozhi/src/ui-state.ts` ✅

- Aggiunto `buildEyeColor(hexColor)` → `{"type":"SET_EYE_COLOR","hex_color":"..."}`

### 1.2 `extensions/xiaozhi/src/tools.ts` ✅

- Aggiunto tool `laragoci_eye_color` — pattern immediato (non deferred)
- Console.log per debug: `[laragoci_eye_color] setting color to #XXXXXX`

### Bug trovato e risolto: Mistral Small non chiamava il tool

- **Causa:** description troppo generica, Mistral non associava "cambia colore occhi" al tool
- **Fix:** description esplicita con "DEVO usare questo tool" + colori precompilati (rosso=FF0000, verde=00FF00, etc.)
- Verificato: dopo il fix, Mistral chiama il tool correttamente

---

## Parte 2 — Firmware C++ 🔧 IN CORSO

### 2.1 `ada_ui_manager.h` ✅ Modificato

```cpp
// Aggiunto membro private + metodo public:
private:
    lv_color_t eye_color_ = lv_color_hex(0x00AAFF);  // default ADA_BLUE
    // NOTA: non usare {.full = 0x00AAFF} — LVGL v9 non ha .full

public:
    void SetEyeColor(lv_color_t color);
```

### 2.2 `ada_ui_manager.cc` ✅ Modificato (da fixare)

**SetEyeColor implementazione** — aggiunta in fondo al file:

```cpp
void AdaUiManager::SetEyeColor(lv_color_t color) {
    ESP_LOGI(TAG, "SetEyeColor: #%06lX", (unsigned long)lv_color_to_int(color));
    eye_color_ = color;
    if (lvgl_port_lock(100)) {
        lv_obj_t* screen = lv_screen_active();
        lv_obj_t* left  = lv_obj_find_by_name(screen, "left_eye");
        lv_obj_t* right = lv_obj_find_by_name(screen, "right_eye");
        ESP_LOGI(TAG, "Eyes found: left=%p right=%p", left, right);
        if (left)  lv_obj_set_style_bg_color(left,  color, 0);
        if (right) lv_obj_set_style_bg_color(right, color, 0);
        lvgl_port_unlock();
    }
}
```

**Ri-applicazione nel case kAdaUiIdle** dentro `SetState()`:

```cpp
case kAdaUiIdle:
    lv_screen_load(idle_screen_);
    if (!lv_color_eq(eye_color_, lv_color_hex(0x00AAFF))) {
        SetEyeColor(eye_color_);
    }
    break;
```

### 2.3 `application.cc` ✅ Modificato

Parser `SET_EYE_COLOR` aggiunto tra `SET_UI` e `ping`:

```cpp
} else if (strcmp(type->valuestring, "SET_EYE_COLOR") == 0) {
    ESP_LOGI(TAG, "SET_EYE_COLOR received");
    auto hex = cJSON_GetObjectItem(root, "hex_color");
    if (cJSON_IsString(hex) && strlen(hex->valuestring) == 6) {
        uint32_t rgb = strtoul(hex->valuestring, nullptr, 16);
        Schedule([rgb]() {
            AdaUiManager::GetInstance().SetEyeColor(lv_color_hex(rgb));
        });
    }
}
```

- Usa `AdaUiManager::GetInstance()` (singleton), NON `ada_ui_manager_->`
- Capture list: `[rgb]` senza `this`

---

## Bug aperto: colore non cambia sul display

**Sintomo:** il tool viene chiamato lato server (`[laragoci_eye_color] setting color to #FF0000`), il messaggio `SET_EYE_COLOR` viene inviato via WS, ma gli occhi non cambiano colore sul device.

**Ipotesi da verificare (prossima sessione):**

1. **Mancava `lvgl_port_lock`** in `SetEyeColor` — le LVGL call richiedono il lock.
   → Fix: wrappare in `if (lvgl_port_lock(100)) { ... lvgl_port_unlock(); }` (**fatto nella versione sopra**)

2. **Nomi eye objects sbagliati** — `"left_eye"` e `"right_eye"` potrebbero non corrispondere ai nomi nel LVGL Pro XML.
   → Verificare con log `ESP_LOGI(TAG, "Eyes found: left=%p right=%p", left, right)` — se stampa `(nil)` i nomi sono sbagliati.
   → Controllare `screen_idle.xml` per i nomi effettivi dei componenti occhi.

3. **Messaggio non arriva al device** — possibile che `sendToActiveSession` non invii al device.
   → Verificare con log `ESP_LOGI(TAG, "SET_EYE_COLOR received")` in `application.cc`.

### Debug prossima sessione

1. Flash firmware con i log aggiunti
2. Dire "Ada cambia colore degli occhi in rosso"
3. Controllare monitor seriale per:
   - `SET_EYE_COLOR received` → messaggio arrivato?
   - `SetEyeColor: #FF0000` → funzione chiamata?
   - `Eyes found: left=0x... right=0x...` → oggetti trovati? (se `(nil)` → nomi sbagliati)

---

## Gotcha LVGL v9 (errori compilazione risolti)

| Errore                                   | Causa                                | Fix                                            |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| `ADA_BLUE not declared`                  | costante non visibile nel .h         | Usare `lv_color_hex(0x00AAFF)`                 |
| `lv_color_t has no member 'full'`        | LVGL v9 non ha `.full`               | Usare `lv_color_eq()` per confronti            |
| `ada_ui_manager_ not declared` in lambda | application.cc usa singleton         | `AdaUiManager::GetInstance().SetEyeColor(...)` |
| `lv_color_hex()` nel .h                  | Funziona in LVGL v9 (constexpr-safe) | OK usare direttamente                          |

---

## Avvio gateway (per test)

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
MISTRAL_API_KEY="$MKEY" OPENAI_TTS_BASE_URL="https://api.mistral.ai/v1" \
  nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
sleep 5 && tail -f /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'
```
