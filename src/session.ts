import * as vscode from "vscode";
import { Client, FTPError } from "basic-ftp";
import { Readable, Writable } from "stream";
import { getConfig } from "./config";
import { zosName } from "./codec";

/**
 * Uma única sessão FTPS persistente ao z/OS.
 *
 * - Pede PIN + token só quando é preciso (re)ligar; a password nunca é guardada em disco
 *   (o PIN só é guardado no SecretStorage se o utilizador ativar "rememberPin").
 * - Todas as operações passam por uma fila: nunca há dois comandos em simultâneo
 *   nem segundas ligações.
 * - Envia NOOP periodicamente para evitar o timeout de inatividade do servidor.
 */
export class FtpSession implements vscode.Disposable {
  private client: Client | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private lastActivity = Date.now();
  private connecting: Promise<void> | undefined;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly _onDidChangeState = new vscode.EventEmitter<boolean>();
  readonly onDidChangeState = this._onDidChangeState.event;
  private userId = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.updateStatus();
    this.statusItem.show();
  }

  get isConnected(): boolean {
    return !!this.client && !this.client.closed;
  }

  get user(): string {
    return this.userId;
  }

  // ---------------------------------------------------------------- ligação

  /** Liga (pedindo PIN + token) se ainda não houver sessão. */
  async ensureConnected(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => (this.connecting = undefined));
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const cfg = getConfig();
    if (!cfg.host) {
      const action = await vscode.window.showErrorMessage(
        "Mainframe FTPS: falta configurar o host (mainframeFtps.host).",
        "Abrir definições"
      );
      if (action) {
        vscode.commands.executeCommand("workbench.action.openSettings", "mainframeFtps");
      }
      throw new CancelledError();
    }

    const user = await this.askUser(cfg.user);
    const pin = await this.askPin();
    const token = await vscode.window.showInputBox({
      title: `Mainframe FTPS – ${user}@${cfg.host}`,
      prompt: "Token atual (4 dígitos do PIN USB)",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (/^\d{4,8}$/.test(v) ? undefined : "Indique os dígitos do token"),
    });
    if (!token) {
      throw new CancelledError();
    }
    const password = cfg.passcodeOrder === "tokenThenPin" ? token + pin : pin + token;

    this.closeClient();
    const client = new Client(cfg.timeoutSeconds * 1000);
    client.ftp.verbose = false;
    this.statusItem.text = "$(sync~spin) MF: a ligar…";

    try {
      this.log.appendLine(
        `[${ts()}] A ligar a ${cfg.host}:${cfg.port} (TLS ${cfg.tlsMode}) como ${user}`
      );
      await client.access({
        host: cfg.host,
        port: cfg.port,
        user,
        password,
        secure: cfg.tlsMode === "implicit" ? "implicit" : true,
        secureOptions: {
          rejectUnauthorized: cfg.rejectUnauthorized,
          servername: cfg.tlsServerName || undefined,
        },
      });
      if (cfg.hostCodePage) {
        await this.sendLogged(client, `SITE SBDATACONN=(${cfg.hostCodePage},${zosName(cfg.transferEncoding)})`);
      }
      for (const site of cfg.siteCommands) {
        await this.sendLogged(client, `SITE ${site}`);
      }
      this.client = client;
      this.userId = user.toUpperCase();
      this.lastActivity = Date.now();
      this.startKeepAlive();
      this.log.appendLine(`[${ts()}] Ligado.`);
      this._onDidChangeState.fire(true);
    } catch (err) {
      client.close();
      this.log.appendLine(`[${ts()}] Falha na ligação: ${errText(err)}`);
      // PIN errado guardado? apaga para voltar a pedir.
      if (err instanceof FTPError && err.code === 530) {
        await this.context.secrets.delete(PIN_KEY);
        throw new Error("Login recusado (530). Verifique o PIN/token. Atenção: várias tentativas falhadas podem revogar o utilizador.");
      }
      throw err;
    } finally {
      this.updateStatus();
    }
  }

  private async askUser(configured: string): Promise<string> {
    if (configured) {
      return configured;
    }
    const remembered = this.context.globalState.get<string>("mainframeFtps.lastUser", "");
    const user = await vscode.window.showInputBox({
      title: "Mainframe FTPS",
      prompt: "Utilizador TSO",
      value: remembered,
      ignoreFocusOut: true,
      validateInput: (v) => (/^[A-Za-z#@$][A-Za-z0-9#@$]{0,7}$/.test(v) ? undefined : "Utilizador inválido"),
    });
    if (!user) {
      throw new CancelledError();
    }
    await this.context.globalState.update("mainframeFtps.lastUser", user);
    return user;
  }

  private async askPin(): Promise<string> {
    const cfg = getConfig();
    if (cfg.rememberPin) {
      const saved = await this.context.secrets.get(PIN_KEY);
      if (saved) {
        return saved;
      }
    }
    const pin = await vscode.window.showInputBox({
      title: "Mainframe FTPS",
      prompt: "Password/PIN fixo",
      password: true,
      ignoreFocusOut: true,
    });
    if (!pin) {
      throw new CancelledError();
    }
    if (cfg.rememberPin) {
      await this.context.secrets.store(PIN_KEY, pin);
    }
    return pin;
  }

  async forgetPin(): Promise<void> {
    await this.context.secrets.delete(PIN_KEY);
  }

  disconnect(): void {
    if (this.client) {
      this.log.appendLine(`[${ts()}] Desligado.`);
    }
    this.closeClient();
    this._onDidChangeState.fire(false);
    this.updateStatus();
  }

  private closeClient(): void {
    this.stopKeepAlive();
    if (this.client) {
      const c = this.client;
      this.client = undefined;
      // QUIT educado, sem esperar
      c.send("QUIT").catch(() => undefined).finally(() => c.close());
    }
  }

  // --------------------------------------------------------------- keepalive

  private startKeepAlive(): void {
    this.stopKeepAlive();
    const cfg = getConfig();
    if (cfg.keepAliveSeconds <= 0) {
      return;
    }
    this.keepAliveTimer = setInterval(() => this.keepAliveTick(), cfg.keepAliveSeconds * 1000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private keepAliveTick(): void {
    if (!this.isConnected) {
      return;
    }
    const cfg = getConfig();
    const idleMin = (Date.now() - this.lastActivity) / 60000;
    if (cfg.idleDisconnectMinutes > 0 && idleMin >= cfg.idleDisconnectMinutes) {
      this.log.appendLine(`[${ts()}] Sem atividade há ${cfg.idleDisconnectMinutes} min: a desligar.`);
      this.disconnect();
      return;
    }
    // NOOP pela fila, sem atualizar lastActivity (não conta como atividade do utilizador)
    this.enqueue(async () => {
      if (!this.client || this.client.closed) {
        return;
      }
      try {
        await this.client.send("NOOP");
      } catch (err) {
        this.log.appendLine(`[${ts()}] Keepalive falhou: ${errText(err)}`);
        this.disconnect();
        vscode.window.showWarningMessage("Mainframe FTPS: a ligação caiu. Será pedido novo token na próxima operação.");
      }
    }).catch(() => undefined);
  }

  // ------------------------------------------------------------------- fila

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Executa uma operação com a sessão. Se a ligação tiver caído, pede novo token,
   * volta a ligar e repete a operação uma vez.
   */
  run<T>(label: string, op: (client: Client) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.ensureConnected();
      this.lastActivity = Date.now();
      try {
        return await op(this.client!);
      } catch (err) {
        if (!isConnectionError(err, this.client)) {
          throw err;
        }
        this.log.appendLine(`[${ts()}] ${label}: ligação perdida (${errText(err)}).`);
        this.disconnect();
        const again = await vscode.window.showWarningMessage(
          `A ligação ao mainframe caiu durante "${label}". Voltar a ligar e repetir?`,
          "Voltar a ligar"
        );
        if (!again) {
          throw new CancelledError();
        }
        await this.ensureConnected();
        this.lastActivity = Date.now();
        return await op(this.client!);
      }
    });
  }

  private async sendLogged(client: Client, cmd: string) {
    const res = await client.send(cmd);
    this.log.appendLine(`  > ${cmd}  < ${res.code} ${firstLine(res.message)}`);
    return res;
  }

  // ------------------------------------------------------- operações z/OS

  /** Grava texto num data set / membro. target ex.: USER.JCL.LIB(MEUJOB) */
  async uploadText(target: string, data: Buffer): Promise<string> {
    return this.run(`gravar ${target}`, async (c) => {
      await c.send("TYPE A");
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      const res = await c.uploadFrom(Readable.from([data]), quoteDsn(target));
      this.log.appendLine(`[${ts()}] Gravado ${target}: ${oneLine(res.message)}`);
      return res.message;
    });
  }

  async downloadText(target: string): Promise<Buffer> {
    return this.run(`ler ${target}`, async (c) => {
      await c.send("TYPE A");
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      const sink = new BufferSink();
      await c.downloadTo(sink, quoteDsn(target));
      return sink.buffer();
    });
  }

  /** Lista os membros de um PDS. */
  async listMembers(pds: string): Promise<string[]> {
    return this.run(`listar ${pds}`, async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      await c.cd(quoteDsn(pds));
      try {
        const raw = await rawList(c, "NLST");
        return raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
      } finally {
        await c.cd(`'${this.userId}.'`).catch(() => undefined);
      }
    });
  }

  /** Submete JCL ao JES. Devolve o JOBID. */
  async submit(jcl: Buffer): Promise<{ jobId: string; message: string }> {
    return this.run("submeter job", async (c) => {
      await c.send("TYPE A");
      await this.sendLogged(c, "SITE FILETYPE=JES");
      try {
        const res = await c.uploadFrom(Readable.from([jcl]), "SUBMIT.JCL");
        const m = /\b(J(?:OB)?\d{5,7})\b/i.exec(res.message);
        this.log.appendLine(`[${ts()}] Submit: ${oneLine(res.message)}`);
        if (!m) {
          throw new Error(`Não foi possível obter o JOBID: ${res.message}`);
        }
        return { jobId: m[1].toUpperCase(), message: res.message };
      } finally {
        await c.send("SITE FILETYPE=SEQ").catch(() => undefined);
      }
    });
  }

  /** Listagem JES em bruto (LIST <jobid> ou LIST de todos os jobs com filtro). */
  async jesList(jobIdOrEmpty: string, jobNameFilter = "*", owner = ""): Promise<string> {
    return this.run("estado do job", async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=JES");
      try {
        if (!jobIdOrEmpty) {
          await this.sendLogged(c, `SITE JESJOBNAME=${jobNameFilter}`);
          await this.sendLogged(c, `SITE JESOWNER=${owner || this.userId}`);
        }
        return await rawList(c, jobIdOrEmpty ? `LIST ${jobIdOrEmpty}` : "LIST");
      } catch (err) {
        // 550 = sem jobs / não encontrado
        if (err instanceof FTPError && err.code === 550) {
          return "";
        }
        throw err;
      } finally {
        await c.send("SITE FILETYPE=SEQ").catch(() => undefined);
      }
    });
  }

  /** Obtém todo o spool de um job (requer JESINTERFACELEVEL=2). */
  async spool(jobId: string): Promise<Buffer> {
    return this.run(`spool ${jobId}`, async (c) => {
      await c.send("TYPE A");
      await this.sendLogged(c, "SITE FILETYPE=JES");
      try {
        const sink = new BufferSink();
        await c.downloadTo(sink, `${jobId}.x`);
        return sink.buffer();
      } finally {
        await c.send("SITE FILETYPE=SEQ").catch(() => undefined);
      }
    });
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.run(`apagar ${jobId}`, async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=JES");
      try {
        await this.sendLogged(c, `DELE ${jobId}`);
      } finally {
        await c.send("SITE FILETYPE=SEQ").catch(() => undefined);
      }
    });
  }

  // ------------------------------------------------------------------- UI

  private updateStatus(): void {
    const cfg = getConfig();
    if (this.isConnected) {
      this.statusItem.text = `$(plug) MF: ${this.userId}@${cfg.host}`;
      this.statusItem.tooltip = "Ligado ao mainframe (clique para desligar)";
      this.statusItem.command = "mainframeFtps.disconnect";
      this.statusItem.backgroundColor = undefined;
    } else {
      this.statusItem.text = "$(debug-disconnect) MF: desligado";
      this.statusItem.tooltip = "Clique para ligar ao mainframe";
      this.statusItem.command = "mainframeFtps.connect";
      this.statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
  }

  dispose(): void {
    this.closeClient();
    this.statusItem.dispose();
    this._onDidChangeState.dispose();
  }
}

// ---------------------------------------------------------------- utilitários

const PIN_KEY = "mainframeFtps.pin";

export class CancelledError extends Error {
  constructor() {
    super("Cancelado");
  }
}

class BufferSink extends Writable {
  private chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Executa um comando de listagem e devolve o texto em bruto (sem parser). */
async function rawList(c: Client, command: string): Promise<string> {
  const original = c.parseList;
  let text = "";
  c.parseList = (raw: string) => {
    text = raw;
    return [];
  };
  try {
    await c.prepareTransfer(c.ftp);
    // método interno do basic-ftp: faz o pedido com o comando exato
    await (c as any)._requestListWithCommand(command);
    return text;
  } finally {
    c.parseList = original;
  }
}

/** Nomes de data set z/OS vão entre plicas para não serem prefixados pelo utilizador. */
export function quoteDsn(dsn: string): string {
  const d = dsn.trim().replace(/^'+|'+$/g, "");
  return `'${d.toUpperCase()}'`;
}

function isConnectionError(err: unknown, client: Client | undefined): boolean {
  if (client?.closed) {
    return true;
  }
  if (err instanceof FTPError) {
    return err.code === 421;
  }
  const msg = errText(err);
  return /ECONNRESET|EPIPE|ETIMEDOUT|socket|closed|Timeout/i.test(msg);
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0];
}

function oneLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, " | ");
}

function ts(): string {
  return new Date().toLocaleTimeString("pt-PT");
}
