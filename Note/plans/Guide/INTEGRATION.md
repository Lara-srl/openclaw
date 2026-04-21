# Integrazione Ada UI nel firmware SenseCAP Watcher

## File da copiare nella cartella firmware ESP-IDF

```
# Codice generato da LVGL Pro
ada_ui.c              →  main/display/ada_ui/ada_ui.c
ada_ui.h              →  main/display/ada_ui/ada_ui.h
ada_ui_gen.c          →  main/display/ada_ui/ada_ui_gen.c
ada_ui_gen.h          →  main/display/ada_ui/ada_ui_gen.h
components/eye/eye_gen.c  →  main/display/ada_ui/components/eye/eye_gen.c
components/eye/eye_gen.h  →  main/display/ada_ui/components/eye/eye_gen.h
screens/screen_idle/screen_idle_gen.c  →  main/display/ada_ui/screens/screen_idle/screen_idle_gen.c
screens/screen_idle/screen_idle_gen.h  →  main/display/ada_ui/screens/screen_idle/screen_idle_gen.h

# Manager wrapper (C++)
ada_ui_manager.h      →  main/display/ada_ui_manager.h
ada_ui_manager.cc     →  main/display/ada_ui_manager.cc
```

## Patch 1: CMakeLists.txt — aggiungere i sorgenti

```cmake
set(SOURCES ...
            "display/ada_ui/ada_ui.c"
            "display/ada_ui/ada_ui_gen.c"
            "display/ada_ui/components/eye/eye_gen.c"
            "display/ada_ui/screens/screen_idle/screen_idle_gen.c"
            "display/ada_ui_manager.cc"
            ...
)

set(INCLUDE_DIRS ... "display/ada_ui" "display/ada_ui/components/eye" "display/ada_ui/screens/screen_idle" ...)
```

## Patch 2: sensecap_watcher.cc

### 2a. Include (dopo `#include "assets/lang_config.h"`):

```cpp
#include "ada_ui_manager.h"
```

### 2b. Costruttore (dopo `InitializeCamera();`, come ultima riga):

```cpp
    // Initialize Ada UI (Astro Bot eyes on IDLE screen)
    {
        DisplayLockGuard lock(display_);
        AdaUiManager::GetInstance().Initialize();
    }
```

## Patch 3: application.cc — dispatch SET_UI

### 3a. Include:

```cpp
#include "ada_ui_manager.h"
```

### 3b. Dentro `protocol_->OnIncomingJson(...)`, aggiungere dopo l'ultimo `else if`:

```cpp
} else if (strcmp(type->valuestring, "SET_UI") == 0) {
    auto state_item = cJSON_GetObjectItem(root, "state");
    if (cJSON_IsNumber(state_item)) {
        int state_code = state_item->valueint;
        Schedule([state_code]() {
            auto display = Board::GetInstance().GetDisplay();
            DisplayLockGuard lock(display);
            AdaUiManager::GetInstance().SetState(
                static_cast<AdaUiStateCode>(state_code));

        });
    }
}
```

## Build & Flash

```bash
cd ~/xiaozhi-esp32
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

## Verifica

1. Boot → schermo nero + 2 pill blu centrate (#00AAFF)
2. Blink ogni ~3.5s (squash height 100→6→100 in 200ms)
3. Serial: `I (xxx) AdaUI: Ada UI initialized — IDLE state active`
