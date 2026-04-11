## Bug immediati da fixare prima di inziare

1. Interventi Immediati (Software/Prompt Engineering)
   Questi sono "Quick Wins" che non richiedono modifiche hardware, ma migliorano drasticamente l'esperienza dei 10 tester.

L'agente è prolisso: \* Azione: Modifica del System Prompt su Mistral. Bisogna impostare un "Constraint" (vincolo) di massimo 20-30 parole per risposta, a meno che non sia richiesto un approfondimento. inoltre se chiedo di modficare un file o altro l'agene incomincia a dirmi che file ha modificato dove quando e perchè. deve darmi la risposta e farmi fare un test per vedere se corretto e basta. solo se chiedo approdonfimento dobbbiamo interagire

Quando: SUBITO. È un cambio di una riga di testo che cambia totalmente la percezione di Ada.

TTS e i simboli (es. "asterisco"): \* Azione: Implementare una funzione di "Sanitizzazione Text-to-Speech" nel Middleman. Prima di inviare il testo al motore TTS, si esegue una regex che rimuove Markdown, asterischi e simboli di formattazione che l'LLM usa per scrivere ma che non vanno letti.

## Fase 2

link per la creazione di asset : https://github.com/78/xiaozhi-assets-generator
mmcp protcol and integration: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-usage.md
device side integration: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-protocol.md
sorgenti : /home/openclaw/openclaw/Note/main per vedre libreria per gestione schermo e mcp oltre che per device
borad specifica : /home/openclaw/openclaw/Note/main/boards/sensecap-watcher

# Punto 2.1 L'Interfaccia Visiva (LVGL + ESP32)

L'obiettivo è creare una UI che non pesi sulla CPU mentre l'audio è in streaming. Utilizzeremo un'architettura Stateless (l'ESP32 esegue solo ordini visivi dal Cloud).

I 7 Stati di Ada:

BOOT (000): Animazione apertura occhi / Connessione Cloud.

IDLE (100): Occhi che battono (basso consumo).

LISTENING (200): Reazione sonora al PTT (Onda).

THINKING (300): Animazione elaborazione Mistral.

ACTING (400): Icona Tool (WhatsApp, Google, Camera, BT).

SPEAKING (500): Animazione bocca/onda a ritmo di sintesi.

SHUTDOWN (900): Occhi che si chiudono / Deep Sleep.

B. Protocollo di Comunicazione UI (JSON via WebSocket)
Il Bridge invierà pacchetti JSON brevi al Watcher per cambiare faccia. Esempio:

JSON
{
"cmd": "SET_UI",
"state": 300, // Thinking
"text": "Sto elaborando...",
"icon": "mistral_icon",
"brightness": 255
}
C. Logica dello State Machine (C++)
Sull'ESP32, useremo un switch case nel loop principale:

Task UI (Low Priority): Gestisce le animazioni degli occhi (loop di 2-3 frame).

Interrupt Task (High Priority): Riceve il pacchetto WebSocket e aggiorna immediatamente gli oggetti LVGL (testo e icone).

3. Hardware & MCP Tools (Il Corpo)

A. Asset Management (Memoria)
Storage: Le immagini (occhi, icone tool) devono essere caricate nella Flash dell'ESP32 usando LittleFS o convertite in C-arrays (binari) per una velocità estrema.

Formato: Usare file .bin (formato LVGL nativo) o PNG leggeri. Risoluzione dello schermo del Watcher: 320x320 pixel.

Font: Utilizzare un font Sans-Serif (es. Montserrat) pre-renderizzato in 3 dimensioni: Small (per i sottotitoli), Medium (per lo stato), Large (per l'orologio o icone grandi).

B. Protocollo di Comunicazione UI (JSON via WebSocket)
Il Bridge invierà pacchetti JSON brevi al Watcher per cambiare faccia. Esempio:

JSON
{
"cmd": "SET_UI",
"state": 300, // Thinking
"text": "Sto elaborando...",
"icon": "mistral_icon",
"brightness": 255
}

C. Logica dello State Machine (C++)
Sull'ESP32, useremo un switch case nel loop principale:

Task UI (Low Priority): Gestisce le animazioni degli occhi (loop di 2-3 frame).

Interrupt Task (High Priority): Riceve il pacchetto WebSocket e aggiorna immediatamente gli oggetti LVGL (testo e icone).

## Punto 2.2 Dettaglio Tecnico: Hardware & MCP Tools

bug della fase uno da sistemare :
Integrazione nella Fase 2 (Hardware & Firmware)
Questi problemi vanno risolti mentre "apriamo il cofano" del Watcher per implementare i Tool MCP e la UI.

Pulsante spegnimento e reset (Bug HW/FW):

Azione: Definizione corretta degli interrupt nel codice C++. Lo spegnimento deve essere un Deep Sleep profondo. Se il device non si spegne, i 10 tester avranno batterie scariche in un'ora.

Quando: DURANTE LA FASE 2. È fondamentale per la stabilità del device che consegnerai. Senza un reset/power-off affidabile, il supporto tecnico ai tester diventerà un incubo per te.

# Tool MCP: Haptic_Feedback

Definizione per l'AI:

Parametro pattern:

short: 1 vibrazione da 50ms (Conferma tocco).

double: 2 vibrazioni da 100ms (Notifica WhatsApp).

long: 1 vibrazione da 500ms (Errore o Alert).

Hardware: Controllo tramite segnale PWM sul pin del motore vibrazione per regolarne l'intensità.

# Tool MCP: LED_Visualizer

Definizione per l'AI:

Parametro hex_color: Es. #00FF00 (Verde).

Parametro mode: static, pulse (respiro), blink (allarme).

Hardware: Controllo tramite la libreria FastLED o Adafruit_NeoPixel (se il LED è un WS2812).

# Tool MCP: Environment_Sense (Sensori + Camera)

Sensori: Ada legge i dati via I2C. Il Bridge deve poter chiedere: GET /sensors.

Camera: Quando Mistral chiama il tool take_photo, l'ESP32 scatta a risoluzione VGA (640x480) per bilanciare dettaglio e velocità di upload. L'immagine viene inviata come Base64 o stream binario al Middleman per l'analisi Vision.

## 2.3 Bluethoot

. Bluetooth Coexistence (A2DP + Wi-Fi)
Questa è la sfida tecnica principale. L'ESP32-S3 deve alternare i tempi di antenna.

Logic: Implementare il Bluetooth in modalità A2DP Sink.

Task Management: Usare due Task separati su FreeRTOS:

Task_Audio_BT: Priorità massima, gestisce il buffer audio verso le cuffie.

Task_Comm_WiFi: Gestisce lo scambio dati con Scaleway.

Buffer: Implementare un buffer di almeno 200ms per evitare "scatti" audio durante i picchi di traffico Wi-Fi.

## Sunto dei tast

Task 1: Crea lo State Manager in C++ usando LVGL per gestire i 7 stati definiti (IDLE, THINKING, etc.) tramite WebSocket JSON.

Task 2: Esponi i controlli hardware (LED, Vibrazione, Camera) come endpoint che il mio Bridge Python in Docker può chiamare via WebSocket."\*

Task 3: Implementa la coesistenza Bluetooth/Wi-Fi per l'audio in cuffia.
