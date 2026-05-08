# R9 — Factory Reset via HTTP

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)
**Dipende da**: [R1](./12_R1_factory_reset_disable.md) (rimozione factory reset dal bottone)

## Obiettivo

Factory reset rimosso dal bottone (R1). Serve un modo remoto per resettare il device.
Esporre un endpoint HTTP sul web server locale del device.

## Framework disponibile

Il firmware usa **ESP-IDF `esp_http_server`** — gia usato nel board Otto Robot come riferimento.

### Pattern esistente

**File reference**: `Note/main/boards/otto-robot/websocket_control_server.cc`

```cpp
httpd_config_t config = HTTPD_DEFAULT_CONFIG();
config.server_port = port;
httpd_start(&server_handle_, &config);

httpd_uri_t uri = {
    .uri = "/ws",
    .method = HTTP_GET,
    .handler = ws_handler,
    .user_ctx = nullptr,
};
httpd_register_uri_handler(server_handle_, &uri);
```

### Factory reset esistente

**File**: `Note/main/boards/common/system_reset.cc`

```cpp
void SystemReset::ResetToFactory() {
    nvs_flash_erase();                          // Cancella NVS (WiFi, config)
    // Erase OTA data partition
    const esp_partition_t* p = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_OTA, NULL);
    esp_partition_erase_range(p, 0, p->size);   // Reset OTA state
    RestartInSeconds(3);                         // Reboot dopo 3s
}
```

Piu completo del semplice `nvs_flash_erase() + esp_restart()` usato dal bottone.

## Implementazione

### 1. Nuovo metodo `InitializeHttpServer()` nel board

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc`

```cpp
void InitializeHttpServer() {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.max_open_sockets = 4;

    if (httpd_start(&http_server_, &config) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start HTTP server");
        return;
    }

    // POST /api/factory-reset
    httpd_uri_t reset_uri = {
        .uri = "/api/factory-reset",
        .method = HTTP_POST,
        .handler = FactoryResetHandler,
        .user_ctx = this,
    };
    httpd_register_uri_handler(http_server_, &reset_uri);

    ESP_LOGI(TAG, "HTTP server started on port 80");
}
```

### 2. Handler con autenticazione basica

```cpp
static esp_err_t FactoryResetHandler(httpd_req_t* req) {
    // Autenticazione: token nel header "X-Reset-Token"
    // Token = MAC address del device (conosciuto solo dal proprietario)
    char token[32] = {0};
    httpd_req_get_hdr_value_str(req, "X-Reset-Token", token, sizeof(token));

    auto self = static_cast<SensecapWatcher*>(req->user_ctx);
    char mac_str[18];
    self->GetMacAddressString(mac_str);  // es. "b4:3a:45:f3:96:30"

    if (strlen(token) == 0 || strcmp(token, mac_str) != 0) {
        httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Invalid token");
        return ESP_OK;
    }

    // Risposta prima del reset
    httpd_resp_set_type(req, "application/json");
    const char* resp = "{\"status\":\"resetting\",\"message\":\"Device will reboot in 3 seconds\"}";
    httpd_resp_send(req, resp, strlen(resp));

    // Factory reset (NVS + OTA + reboot)
    ESP_LOGI(TAG, "HTTP factory reset triggered");
    nvs_flash_erase();
    esp_restart();

    return ESP_OK;
}
```

### 3. Membro nel header

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.h`

```cpp
httpd_handle_t http_server_ = nullptr;
```

### 4. Chiamare init nel costruttore

In `sensecap_watcher.cc`, dopo `InitializeButton()` e `InitializePowerSaveTimer()`:

```cpp
InitializeHttpServer();
```

## Utilizzo

```bash
# Da qualsiasi device sulla stessa rete WiFi
curl -X POST http://<device-ip>/api/factory-reset \
     -H "X-Reset-Token: b4:3a:45:f3:96:30"
```

Risposta:

```json
{ "status": "resetting", "message": "Device will reboot in 3 seconds" }
```

## Sicurezza

- **Token = MAC address** del device — stampato sull'etichetta fisica, noto solo al proprietario
- Non e' sicurezza forte, ma sufficiente per evitare reset accidentali
- L'endpoint e' accessibile solo sulla rete locale (no port forwarding di default)
- Alternativa: token generato casualmente salvato in NVS al primo boot

## Conflitto con WiFi config AP

Il WiFi manager (captive portal) usa porta 80 in modalita AP. Il nostro server HTTP:

- **Non si avvia in AP mode** — solo quando connesso a WiFi STA
- Se conflitto: usare porta alternativa (es. 8080)
- Check: verificare se `WifiManager` rilascia la porta quando esce da config mode

## File coinvolti

| File                                | Modifica                                          |
| ----------------------------------- | ------------------------------------------------- |
| `sensecap_watcher.cc` (nuovo)       | `InitializeHttpServer()`, `FactoryResetHandler()` |
| `sensecap_watcher.h`                | `httpd_handle_t http_server_`                     |
| `sensecap_watcher.cc` (constructor) | Chiamare `InitializeHttpServer()`                 |

## Verifica

- [ ] `curl -X POST .../api/factory-reset -H "X-Reset-Token: <MAC>"` → device resetta e reboota
- [ ] Senza token → 403 Forbidden
- [ ] Token sbagliato → 403 Forbidden
- [ ] Dopo reset: WiFi SSID cancellate, device in AP config mode
- [ ] Console seriale `factory_reset` ancora funzionante (R1)

## Complessita: S-M

Server HTTP nuovo, ma pattern standard ESP-IDF. Un endpoint, un handler. Rischio: conflitto porta con WiFi manager.
