# Note Audio — Voce italiana per Voxtral TTS

> Creato: 2026-03-31

---

## Registrazione voce per voice cloning Mistral

### Specifiche tecniche

- **Formato**: WAV 44.1kHz o 48kHz (Mistral accetta entrambi)
- **Durata**: 10–30 secondi — oltre non migliora la qualità del clone
- **Canali**: mono o stereo (mono preferito)

### Consigli per la registrazione

- Tono naturale e conversazionale — non da speaker TV
- Stanza silenziosa, nessun rumore di fondo
- Studio professionale = qualità massima

### Come caricare la voce

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
curl -X POST https://api.mistral.ai/v1/audio/voices \
  -H "Authorization: Bearer $MKEY" \
  -F 'file=@voce-italiana.wav' \
  -F 'name=lara-italiana'
# Risposta: {"id":"<UUID>","name":"lara-italiana",...}
```

Copia UUID → aggiorna `~/.openclaw/openclaw.json` → `messages.tts.openai.voice`

---

## Voce attuale

| Campo    | Valore                                     |
| -------- | ------------------------------------------ |
| Nome     | `francesco`                                |
| voice_id | `10e8fb02-3a0a-4b93-81c2-32bd37b7d6a4`     |
| Qualità  | Bassa — registrazione microfono PC         |
| Stato    | Temporanea — da sostituire con voce studio |
