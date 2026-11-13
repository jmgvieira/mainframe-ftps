import * as vscode from "vscode";
import { FtpSession, errText, CancelledError } from "./session";
import { getConfig } from "./config";

export interface JobInfo {
  jobId: string;
  jobName: string;
  status: string; // INPUT, ACTIVE, OUTPUT, HELD, ?
  result: string; // RC=0000, ABEND=S0C7, (JCL error) ...
  submitted: number;
  source?: string;
}

const STATE_KEY = "mainframeFtps.jobs";
const MAX_JOBS = 30;

/** Interpreta a linha de um job numa listagem JES (JESINTERFACELEVEL=2). */
export function parseJobLine(raw: string, jobId: string): Partial<JobInfo> | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[1]?.toUpperCase() === jobId.toUpperCase()) {
      // JOBNAME JOBID OWNER STATUS CLASS [resto]
      const rest = line.trim().split(/\s+/).slice(5).join(" ");
      return {
        jobName: t[0],
        status: (t[3] ?? "?").toUpperCase(),
        result: rest.replace(/\s*\d+\s+spool files?.*$/i, "").trim(),
      };
    }
  }
  return undefined;
}

export function parseJobList(raw: string): Array<Partial<JobInfo> & { jobId: string }> {
  const out: Array<Partial<JobInfo> & { jobId: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length >= 4 && /^(J(OB)?|T(SU)?|S(TC)?)\d{5,7}$/i.test(t[1] ?? "")) {
      out.push({
        jobId: t[1].toUpperCase(),
        jobName: t[0],
        status: t[3].toUpperCase(),
        result: t.slice(5).join(" ").replace(/\s*\d+\s+spool files?.*$/i, "").trim(),
      });
    }
  }
  return out;
}

export function severity(job: Partial<JobInfo>): "ok" | "warn" | "error" | "running" {
  if (job.status !== "OUTPUT") {
    return "running";
  }
  const r = (job.result ?? "").toUpperCase();
  if (/ABEND|JCL ERROR|CC FLUSH|SYS|CANCEL/.test(r)) {
    return "error";
  }
  const rc = /RC=(\d+)/.exec(r);
  if (rc) {
    const n = parseInt(rc[1], 10);
    return n === 0 ? "ok" : n <= 4 ? "warn" : "error";
  }
  return "ok";
}

export class JobsProvider implements vscode.TreeDataProvider<JobInfo>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<JobInfo | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private jobs: JobInfo[];
  private pollers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: FtpSession,
    private readonly log: vscode.OutputChannel
  ) {
    this.jobs = context.workspaceState.get<JobInfo[]>(STATE_KEY, []);
  }

  getTreeItem(job: JobInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(`${job.jobName || "?"}  ${job.jobId}`);
    item.description = [job.status, job.result].filter(Boolean).join(" · ");
    item.tooltip = `${job.jobId} ${job.jobName}\nEstado: ${job.status} ${job.result}\nSubmetido: ${new Date(
      job.submitted
    ).toLocaleString("pt-PT")}${job.source ? `\nOrigem: ${job.source}` : ""}`;
    const sev = severity(job);
    item.iconPath =
      sev === "running"
        ? new vscode.ThemeIcon("sync~spin")
        : sev === "ok"
        ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
        : sev === "warn"
        ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
        : new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    item.contextValue = "mfJob";
    item.command = { command: "mainframeFtps.openSpool", title: "Ver spool", arguments: [job] };
    return item;
  }

  getParent(): undefined {
    return undefined;
  }

  getChildren(): JobInfo[] {
    return this.jobs;
  }

  all(): JobInfo[] {
    return this.jobs;
  }

  async add(jobId: string, jobName: string, source?: string): Promise<JobInfo> {
    const job: JobInfo = { jobId, jobName, status: "INPUT", result: "", submitted: Date.now(), source };
    this.jobs = [job, ...this.jobs.filter((j) => j.jobId !== jobId)].slice(0, MAX_JOBS);
    await this.save();
    this.startPolling(job);
    return job;
  }

  async remove(job: JobInfo): Promise<void> {
    this.stopPolling(job.jobId);
    this.jobs = this.jobs.filter((j) => j.jobId !== job.jobId);
    await this.save();
  }

  async clear(): Promise<void> {
    for (const id of this.pollers.keys()) {
      this.stopPolling(id);
    }
    this.jobs = [];
    await this.save();
  }

  /** Atualiza o estado de um job a partir do JES. */
  async refresh(job: JobInfo): Promise<JobInfo> {
    const raw = await this.session.jesList(job.jobId);
    const parsed = parseJobLine(raw, job.jobId);
    if (parsed) {
      Object.assign(job, parsed);
    } else {
      job.status = "?";
      job.result = "não encontrado no JES";
    }
    await this.save();
    return job;
  }

  async refreshAll(): Promise<void> {
    if (!this.session.isConnected) {
      this._onDidChange.fire(undefined);
      return;
    }
    for (const job of this.jobs.filter((j) => j.status !== "OUTPUT")) {
      await this.refresh(job).catch(() => undefined);
    }
    this._onDidChange.fire(undefined);
  }

  startPolling(job: JobInfo): void {
    const cfg = getConfig();
    this.stopPolling(job.jobId);
    const deadline = Date.now() + cfg.pollMaxMinutes * 60000;
    const tick = async () => {
      if (!this.session.isConnected || Date.now() > deadline) {
        this.stopPolling(job.jobId);
        return;
      }
      try {
        await this.refresh(job);
      } catch (err) {
        if (!(err instanceof CancelledError)) {
          this.log.appendLine(`Erro a consultar ${job.jobId}: ${errText(err)}`);
        }
        this.stopPolling(job.jobId);
        return;
      }
      if (job.status === "OUTPUT") {
        this.stopPolling(job.jobId);
        this.notifyFinished(job);
      }
    };
    this.pollers.set(job.jobId, setInterval(tick, Math.max(2, cfg.pollSeconds) * 1000));
  }

  private stopPolling(jobId: string): void {
    const t = this.pollers.get(jobId);
    if (t) {
      clearInterval(t);
      this.pollers.delete(jobId);
    }
  }

  private async notifyFinished(job: JobInfo): Promise<void> {
    const msg = `${job.jobName} ${job.jobId} terminou: ${job.result || "OUTPUT"}`;
    const sev = severity(job);
    const show =
      sev === "error"
        ? vscode.window.showErrorMessage
        : sev === "warn"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
    const action = await show(msg, "Ver spool");
    if (action) {
      vscode.commands.executeCommand("mainframeFtps.openSpool", job);
    }
  }

  private async save(): Promise<void> {
    await this.context.workspaceState.update(STATE_KEY, this.jobs);
    this._onDidChange.fire(undefined);
  }

  dispose(): void {
    for (const id of [...this.pollers.keys()]) {
      this.stopPolling(id);
    }
    this._onDidChange.dispose();
  }
}
