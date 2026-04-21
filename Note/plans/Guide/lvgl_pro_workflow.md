# LVGL Pro — Workflow XML → Firmware

Guida per creare schermate Ada UI con LVGL Pro ed integrarle nel firmware SenseCAP Watcher.

## Requisiti

- **LVGL Pro** desktop app (Windows/Mac/Linux) — https://lvgl.io/pro
- Progetto Ada UI: `Note/ada_ui/` nel repo
- Firmware ESP-IDF: `~/xiaozhi-esp32/` sulla VM firmware (Windows)

## 1. Struttura progetto LVGL Pro

```
Note/ada_ui/
├── project.xml                          ← config display (412x412)
├── globals.xml                          ← palette colori + costanti
├── components/
│   └── <nome_componente>/
│       └── <nome_componente>.xml        ← componente riusabile
├── screens/
│   └── <nome_screen>/
│       └── <nome_screen>.xml            ← screen (stato Ada)
├── images/
└── fonts/
```

### project.xml

```xml
<project>
    <targets>
        <target name="target1">
            <display width="412" height="412" />
        </target>
    </targets>
</project>
```

### globals.xml

Definisce costanti e colori globali. **ATTENZIONE ai nomi**: i nomi diventano `#define` in C (es. `ada_ew` → `ADA_EW`). Non usare nomi che collidono con include guard dei componenti (es. `eye_h` collide con `EYE_H` di `eye_gen.h`).

```xml
<globals>
    <api />
    <consts>
        <color name="bg_dark" value="0x000000" />
        <color name="ada_blue" value="0x00AAFF" />
        <int name="ada_ew" value="70" />
        <int name="ada_eh" value="100" />
    </consts>
    <styles />
    <subjects />
    <images />
    <fonts />
</globals>
```

**Regola naming**: usare prefisso `ada_` per tutte le costanti globali.

### Componenti

Un componente è un widget riusabile. Esempio `components/eye/eye.xml`:

```xml
<component>
    <api />
    <styles>
        <style name="pill"
            width="#ada_ew"
            height="#ada_eh"
            radius="#ada_er"
            bg_color="#ada_blue"
            bg_opa="255"
            border_width="0"
        />
    </styles>
    <view extends="lv_obj">
        <style name="pill" />
    </view>
</component>
```

### Screen

Uno screen rappresenta uno stato Ada. Esempio `screens/screen_idle/screen_idle.xml`:

```xml
<screen>
    <styles>
        <style name="screen_bg"
            width="412"
            height="412"
            bg_color="#bg_dark"
            bg_opa="255"
        />
    </styles>
    <animations>
        <timeline name="blink">
            <animation target="left_eye" prop="height"
                start="100" end="6" duration="100" delay="0" />
            <animation target="left_eye" prop="height"
                start="6" end="100" duration="100" delay="100" />
            <animation target="right_eye" prop="height"
                start="100" end="6" duration="100" delay="0" />
            <animation target="right_eye" prop="height"
                start="6" end="100" duration="100" delay="100" />
        </timeline>
    </animations>
    <view>
        <style name="screen_bg" />
        <play_timeline_event target="self" timeline="blink" trigger="screen_loaded" />
        <eye name="left_eye" x="106" y="156" />
        <eye name="right_eye" x="236" y="156" />
    </view>
</screen>
```

## 2. Regole XML LVGL Pro

### Cosa NON funziona

| Errore comune                                        | Soluzione                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `<view ... />` (self-closing)                        | Usare `<view ...></view>`                                         |
| `bg_color="..."` come attributo di `<view>`          | Metterlo in uno `<style>` e applicarlo con `<style name="..." />` |
| `radius`, `bg_opa`, `border_width` su `<view>`       | Stessi — vanno dentro `<style>`                                   |
| Costante `eye_h` → collide con `EYE_H` include guard | Usare nomi con prefisso (`ada_eh`)                                |
| `<view extends="lv_obj">` su screen                  | Screen usa `<view>` senza extends                                 |

### Cosa funziona

- `width`, `height`, `x`, `y`, `name` sono attributi validi di `<view>`
- `<style>` come child di `<view>` applica lo stile all'oggetto
- `#nome_costante` referenzia una costante da `globals.xml`
- `<animation>` con `prop`, `start`, `end`, `duration`, `delay`
- `<play_timeline_event>` con `trigger="screen_loaded"`

## 3. Generazione codice C

In LVGL Pro:

1. **File → Open Project** → selezionare la cartella `Note/ada_ui/`
2. Verificare preview (sfondo nero, pill blu)
3. **Build → Generate C Code** (o icona martello)

### Output generato

```
ada_ui.c / ada_ui.h                    ← entry point: ada_ui_init()
ada_ui_gen.c / ada_ui_gen.h            ← costanti (#define), include componenti
components/eye/eye_gen.c / .h          ← eye_create(parent)
screens/screen_idle/screen_idle_gen.c / .h  ← screen_idle_create(), timeline blink
```

### File generati vs file manuali

| File                  | Generato da LVGL Pro | Manuale          |
| --------------------- | -------------------- | ---------------- |
| `ada_ui*.c/h`         | ✅                   |                  |
| `*_gen.c/h`           | ✅                   |                  |
| `ada_ui_manager.cc/h` |                      | ✅ (wrapper C++) |
| `INTEGRATION.md`      |                      | ✅               |

**Non modificare i file `*_gen.*`** — vengono sovrascritti ad ogni rigenerazione.
Modifiche custom vanno in `ada_ui.c` (dopo `ada_ui_init_gen()`) o in `ada_ui_manager.cc`.

## 4. Integrazione firmware

### Struttura target sul firmware

```
main/display/
├── ada_ui/                         ← codice generato LVGL Pro
│   ├── ada_ui.c
│   ├── ada_ui.h
│   ├── ada_ui_gen.c
│   ├── ada_ui_gen.h
│   ├── components/
│   │   └── eye/
│   │       ├── eye_gen.c
│   │       └── eye_gen.h
│   └── screens/
│       └── screen_idle/
│           ├── screen_idle_gen.c
│           └── screen_idle_gen.h
├── ada_ui_manager.h                ← wrapper C++ (manuale)
├── ada_ui_manager.cc
├── lcd_display.cc
└── ...
```

### CMakeLists.txt

```cmake
set(SOURCES ...
    "display/ada_ui/ada_ui.c"
    "display/ada_ui/ada_ui_gen.c"
    "display/ada_ui/components/eye/eye_gen.c"
    "display/ada_ui/screens/screen_idle/screen_idle_gen.c"
    "display/ada_ui_manager.cc"
    ...
)

set(INCLUDE_DIRS ... "display/ada_ui" ...)
```

**NON aggiungere** `components/eye/` o `screens/screen_idle/` a `INCLUDE_DIRS` — i file generati usano path relativi (`../../ada_ui.h`).

### sensecap_watcher.cc

```cpp
#include "ada_ui_manager.h"
```

**IMPORTANTE**: NON chiamare `AdaUiManager::Initialize()` nel costruttore `SensecapWatcher()` — `Application::Initialize()` chiama `SetupUI()` dopo il costruttore e sovrascrive lo screen.

Chiamare invece dentro `CustomLcdDisplay::SetupUI()`, come ultima riga:

```cpp
virtual void SetupUI() override {
    SpiLcdDisplay::SetupUI();
    // ... existing UI customization ...

    // Load Ada UI screen (replaces default UI)
    AdaUiManager::GetInstance().Initialize();
}
```

## 5. Build & Flash

```powershell
cd ~/xiaozhi-esp32
idf.py fullclean    # prima volta o dopo modifiche strutturali
idf.py build
idf.py -p COM3 flash monitor
```

## 6. Aggiungere un nuovo stato

Per aggiungere es. lo stato LISTENING (200):

1. Creare `screens/screen_listening/screen_listening.xml` in LVGL Pro
2. Rigenerare il codice C
3. Aggiungere i nuovi `*_gen.c` a `CMakeLists.txt`
4. In `ada_ui_manager.cc` → `SetState()`: aggiungere il case per `kAdaUiListening` che chiama `screen_listening_create()` e `lv_screen_load()`

## 7. Troubleshooting

| Problema                     | Causa                                          | Fix                                                             |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Schermo bianco               | `bg_color` su `<view>` invece che su `<style>` | Spostare in `<style>`                                           |
| `eye_create` undeclared      | Costante collide con include guard             | Rinominare con prefisso `ada_`                                  |
| `Cannot find source file`    | File non nella posizione giusta                | Verificare struttura cartelle                                   |
| 320x240 nel preview          | `project.xml` non caricato                     | Verificare `<display width="412" height="412" />`               |
| Timeline non ripete          | LVGL Pro timeline è one-shot                   | Usare `esp_timer` per retriggerate                              |
| `lv_obj_set_name` undeclared | `LV_USE_OBJ_NAME` disabilitato                 | `CONFIG_LV_USE_OBJ_NAME=y` in sdkconfig                         |
| Screen nero ma UI chat sopra | `SetupUI()` sovrascrive lo screen              | Chiamare Ada init dentro `SetupUI()`, non nel costruttore board |
