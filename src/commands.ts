import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JobManager } from "./job-manager.ts";
import { formatElapsed } from "./widget.ts";

export function registerBackgroundCommands(pi: ExtensionAPI, manager: JobManager): void {
  const openInteractiveMenu = async (ctx: ExtensionContext) => {
    const jobs = manager.getAllJobs();

    if (jobs.length === 0) {
      ctx.ui.notify("Nessuna operazione in background attiva o recente.", "info");
      return;
    }

    const jobOptions = jobs.map((j) => {
      const icon = j.status === "running" ? "●" : j.status === "completed" ? "✓" : "✖";
      const duration = formatElapsed(j.startedAt, j.endedAt);
      const target = j.placement === "tab" ? `tab: ${j.tabLabel}` : `pane: ${j.paneId}`;
      return `${icon} [${j.id}] ${j.name} (${j.status}, ${duration}) · ${target}`;
    });

    const chosenOption = await ctx.ui.select(
      "Seleziona operazione in background:",
      jobOptions,
    );

    if (!chosenOption) return;

    // Find the selected job
    const match = chosenOption.match(/\[(bg-\d+)\]/);
    if (!match) return;
    const jobId = match[1];
    const job = manager.getJob(jobId);
    if (!job) return;

    // Show actions for this job
    const actionOptions = [
      "🚀 Apri terminale in una tab a parte (Focus)",
      "📄 Leggi output recente (Scrollback)",
      "🛑 Invia segnale di interruzione (Ctrl+C)",
      "❌ Chiudi terminale / tab definitivamente",
    ];

    const action = await ctx.ui.select(
      `Operazione [${job.id}] "${job.name}" - Scegli azione:`,
      actionOptions,
    );

    if (!action) return;

    if (action.startsWith("🚀")) {
      try {
        await manager.focusJobTab(job.id);
        ctx.ui.notify(`Terminale aperto e selezionato in Herdr: "${job.name}"`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Errore nell'apertura della tab: ${err.message}`, "error");
      }
    } else if (action.startsWith("📄")) {
      try {
        const output = await manager.readOutput(job.id, 100);
        await ctx.ui.editor(
          `Log terminale [${job.id}] - ${job.name} (premi Esc o Salva per uscire)`,
          output || "(Nessun output registrato finora)",
        );
      } catch (err: any) {
        ctx.ui.notify(`Errore durante la lettura dell'output: ${err.message}`, "error");
      }
    } else if (action.startsWith("🛑")) {
      try {
        await manager.stopJob(job.id);
        ctx.ui.notify(`Segnale di interruzione (Ctrl+C) inviato a [${job.id}]`, "warning");
      } catch (err: any) {
        ctx.ui.notify(`Errore durante l'interruzione: ${err.message}`, "error");
      }
    } else if (action.startsWith("❌")) {
      const confirm = await ctx.ui.confirm(
        "Conferma chiusura",
        `Vuoi davvero chiudere definitivamente il terminale per [${job.id}]?`,
      );
      if (confirm) {
        try {
          await manager.closeJobTerminal(job.id);
          ctx.ui.notify(`Terminale [${job.id}] chiuso con successo.`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Errore durante la chiusura del terminale: ${err.message}`, "error");
        }
      }
    }
  };

  // ── /backgrounds command ──
  pi.registerCommand("backgrounds", {
    description: "Visualizza e gestisci le operazioni in background e i terminali aperti",
    handler: async (_args, ctx) => {
      await openInteractiveMenu(ctx);
    },
  });

  // ── /bg alias ──
  pi.registerCommand("bg", {
    description: "Alias rapido per /backgrounds",
    handler: async (_args, ctx) => {
      await openInteractiveMenu(ctx);
    },
  });

  // ── Ctrl+B shortcut ──
  try {
    pi.registerShortcut("ctrl+b", {
      description: "Gestione terminali e operazioni in background (ww-backgrounds)",
      handler: async (ctx) => {
        await openInteractiveMenu(ctx);
      },
    });
  } catch {
    // If shortcut is already registered or unsupported in current environment, ignore
  }
}
