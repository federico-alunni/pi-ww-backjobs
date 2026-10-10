# ww-backgrounds

Estensione per **[Pi coding agent](https://github.com/badlogic/pi-mono)** e **[Herdr](https://herdr.dev)** per visualizzare e gestire operazioni e comandi in background lanciati dagli agenti, con un mini-widget informativo sopra l'editor e la possibilità di aprire e gestire i terminali dedicati in tab separate.

---

## Funzionalità principali

1. **Esecuzione non bloccante per gli agenti (`background_run`)**:
   - Gli agenti possono avviare processi persistenti o di lunga durata (es. dev server `npm run dev`, suite di test `cargo test --watch`, docker compose, build lunghe).
   - L'agente non rimane bloccato ad attendere la fine del comando: il turno prosegue normalmente mentre il job gira in un terminale reale gestito da Herdr.

2. **Mini Widget nella TUI (`setWidget`)**:
   - Un box compatto posizionato sopra l'editor di Pi mostra in tempo reale:
     - Stato dell'operazione (`● running`, `✓ completed`, `✖ failed`, `■ stopped`).
     - Nome del task e ID univoco (`[bg-1]`).
     - Posizione Herdr (es. `tab: dev-server` o `pane: w6:p3`).
     - Tempo trascorso o durata complessiva.
   - Si nasconde automaticamente quando non ci sono operazioni attive o recenti.

3. **Aprire e gestire i terminali in una tab (`/bg` o `Ctrl+B`)**:
   - Menu interattivo con selezione rapida:
     - 🚀 **Apri terminale in una tab a parte (Focus)**: porta subito il focus dell'utente sulla scheda Herdr del terminale.
     - 📄 **Leggi output recente**: visualizza gli ultimi log senza cambiare tab.
     - 🛑 **Interrompi operazione (Ctrl+C)**: arresta il processo in esecuzione.
     - ❌ **Chiudi terminale/tab**: chiude definitivamente la scheda di Herdr.

---

## Tool per gli Agenti

| Tool | Descrizione |
| --- | --- |
| `background_run` | Avvia un comando shell in un terminale Herdr in background (`tab` o `split`). |
| `background_list` | Elenca tutte le operazioni attive e recenti con stato, durata e ID terminale. |
| `background_read` | Legge le ultime righe di output dal terminale dell'operazione. |
| `background_stop` | Invia un segnale di interruzione (`Ctrl+C`) al job specificato. |

### Parametri di `background_run`
- `command` (string, obbligatorio): il comando shell da eseguire.
- `name` (string, opzionale): etichetta o nome sintetico del task.
- `cwd` (string, opzionale): cartella di lavoro (default: directory corrente).
- `placement` (opzionale, `"tab"` \| `"split"`, default `"tab"`): dove eseguire il processo.

---

## Comandi e Scorciatoie per l'Utente

- `/backgrounds` (oppure `/bg`): apre il menu di selezione e gestione dei terminali in background.
- `Ctrl+B`: scorciatoia rapida da tastiera per aprire lo stesso menu interattivo.

---

## Installazione

In Pi:

```bash
pi install /Users/federico.alunni/code/personal/ww-backgrounds
```

Oppure aggiungendolo a `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/Users/federico.alunni/code/personal/ww-backgrounds"
  ]
}
```

---

## Licenza

MIT
