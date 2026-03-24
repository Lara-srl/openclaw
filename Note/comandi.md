# Comandi utili — LaraGoci / XiaoZhi

## Avvia / riavvia gateway

```bash
# IMPORTANTE: usare KEY esplicita per evitare che il gateway erediti chiave sbagliata
KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
ANTHROPIC_API_KEY="$KEY" nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
sleep 3 && tail -5 /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'
```

## Log in tempo reale

```bash
tail -f /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'
tail -f /tmp/openclaw-gateway.log | grep --line-buffered "XZ\|xiaozhi"
```

## Verifica chiave API nel gateway attivo

```bash
ps aux | grep "openclaw gateway" | grep -v grep | awk '{print $2}' | head -1 \
  | xargs -I{} cat /proc/{}/environ 2>/dev/null | tr '\0' '\n' | grep ANTHROPIC | cut -c-40
```

## Test API key

```bash
KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2-)
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"ping"}]}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('type')=='message' else d.get('error'))"
```

## Mock client (test pipeline senza device fisico)

```bash
# silenzio sintetico
bun scripts/xiaozhi-mock-client.ts

# con audio WAV reale (16kHz mono)
bun scripts/xiaozhi-mock-client.ts --wav /path/to/audio.wav --out received-tts.wav
```
