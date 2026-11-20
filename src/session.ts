import * as tls from "tls";
import * as vscode from "vscode";
import { Client, FTPError } from "basic-ftp";
import { Readable, Writable } from "stream";
import { getConfig, activeServer, servers, setActiveServer } from "./config";
import { localBase } from "./mapping";
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
  /** Nome do servidor da ligação aberta (da lista mainframeFtps.hosts). */
  private serverName = "";
  private connectedSince = 0;
  private lastKeepAlive = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.updateStatus();
    this.statusItem.show();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("mainframeFtps.localFolder")) {
          this.updateStatus();
        }
        if (e.affectsConfiguration("mainframeFtps.hosts") || e.affectsConfiguration("mainframeFtps.host")) {
          this.updateStatus();
          this._onDidChangeState.fire(this.isConnected);
        }
      })
    );
  }

  /** Servidor da ligação aberta ou, sem ligação, o que será usado na próxima. */
  get server(): string {
    return this.isConnected ? this.serverName : activeServer()?.name ?? "";
  }

  /** Muda de servidor: fecha a sessão atual (se houver) e liga ao novo, pedindo PIN + token. */
  async switchServer(name: string): Promise<void> {
    if (this.isConnected && this.serverName === name) {
      return;
    }
    if (this.client) {
      this.log.appendLine(`[${ts()}] Switching from ${this.serverName} to ${name}.`);
    }
    // espera que acabe o que estiver na fila antes de fechar
    await this.queue;
    this.disconnect();
    await setActiveServer(name);
    this.updateStatus();
    this._onDidChangeState.fire(false);
    await this.ensureConnected();
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
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
        this.updateStatus();
      });
      this.updateStatus();
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const cfg = getConfig();
    if (!cfg.host) {
      const action = await vscode.window.showErrorMessage(
        "Mainframe FTPS: no servers configured (mainframeFtps.hosts).",
        "Open settings"
      );
      if (action) {
        vscode.commands.executeCommand("workbench.action.openSettings", "mainframeFtps.hosts");
      }
      throw new CancelledError();
    }
    const serverName = activeServer()?.name ?? cfg.host;

    const user = await this.askUser(cfg.user);
    const password = await this.askPassword(user, serverName === cfg.host ? cfg.host : `${serverName} (${cfg.host})`);
    this.closeClient();
    const client = new Client(cfg.timeoutSeconds * 1000);
    client.ftp.verbose = false;
    // listagens chegam no código de página da ligação de dados (ISO-8859-x), não em UTF-8
    client.ftp.encoding = "latin1";

    try {
      this.log.appendLine(
        `[${ts()}] Connecting to ${serverName} (${cfg.host}:${cfg.port}, TLS ${cfg.tlsMode}) as ${user}`
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
          // por omissão a versão é negociada (o servidor da empresa só aceita TLS 1.3)
          ...(cfg.tlsMaxVersion === "TLSv1.2" || cfg.tlsMaxVersion === "TLSv1.3"
            ? { maxVersion: cfg.tlsMaxVersion as tls.SecureVersion }
            : {}),
        },
      });
      pinControlSession(client, (m) => this.log.appendLine(m));
      const ctl = client.ftp.socket as tls.TLSSocket;
      if (typeof ctl.getProtocol === "function") {
        this.log.appendLine(`  TLS ${ctl.getProtocol() ?? "?"} · ${ctl.getCipher()?.name ?? "?"}`);
      }
      if (cfg.hostCodePage) {
        await this.sendLogged(client, `SITE SBDATACONN=(${cfg.hostCodePage},${zosName(cfg.transferEncoding)})`);
      }
      for (const site of cfg.siteCommands) {
        await this.sendLogged(client, `SITE ${site}`);
      }
      this.client = client;
      this.userId = user.toUpperCase();
      this.serverName = serverName;
      this.connectedSince = Date.now();
      this.lastKeepAlive = Date.now();
      this.lastActivity = Date.now();
      this.startKeepAlive();
      this.log.appendLine(`[${ts()}] Connected.`);
      this._onDidChangeState.fire(true);
    } catch (err) {
      client.close();
      this.log.appendLine(`[${ts()}] Connection failed: ${errText(err)}`);
      // PIN errado guardado? apaga para voltar a pedir.
      if (err instanceof FTPError && err.code === 530) {
        await this.context.secrets.delete(PIN_KEY);
        throw new Error("Login rejected (530). Check the PIN/token. Warning: several failed attempts may revoke the user ID.");
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
      prompt: "TSO user ID",
      value: remembered,
      ignoreFocusOut: true,
      validateInput: (v) => (/^[A-Za-z#@$][A-Za-z0-9#@$]{0,7}$/.test(v) ? undefined : "Invalid user ID"),
    });
    if (!user) {
      throw new CancelledError();
    }
    await this.context.globalState.update("mainframeFtps.lastUser", user);
    return user;
  }

  /**
   * Pede a password num único campo. Por omissão o utilizador escreve o PIN fixo
   * e o token seguidos (ex.: ABCD1234) e carrega Enter uma vez, como no TSO.
   * Com "rememberPin" ativo e o PIN já guardado, basta escrever o token.
   */
  private async askPassword(user: string, host: string): Promise<string> {
    const cfg = getConfig();
    const tokenFirst = cfg.passcodeOrder === "tokenThenPin";
    const saved = cfg.rememberPin ? await this.context.secrets.get(PIN_KEY) : undefined;
    if (saved) {
      const token = await vscode.window.showInputBox({
        title: `Mainframe FTPS – ${user}@${host}`,
        prompt: "Token (fixed PIN already stored)",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (/^\d{4,8}$/.test(v) ? undefined : "Enter the token digits"),
      });
      if (!token) {
        throw new CancelledError();
      }
      return tokenFirst ? token + saved : saved + token;
    }
    const pwd = await vscode.window.showInputBox({
      title: `Mainframe FTPS – ${user}@${host}`,
      prompt: tokenFirst ? "Token + fixed PIN, typed together" : "Fixed PIN + token, typed together",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.length >= 5 ? undefined : "Type the fixed PIN and the token together"),
    });
    if (!pwd) {
      throw new CancelledError();
    }
    if (cfg.rememberPin) {
      // o token são os dígitos no fim (ou no início); o resto é o PIN fixo
      const m = tokenFirst ? /^(\d{4})(.+)$/.exec(pwd) : /^(.+?)(\d{4})$/.exec(pwd);
      const pin = m ? (tokenFirst ? m[2] : m[1]) : "";
      if (pin) {
        await this.context.secrets.store(PIN_KEY, pin);
      }
    }
    return pwd;
  }

  async forgetPin(): Promise<void> {
    await this.context.secrets.delete(PIN_KEY);
  }

  disconnect(): void {
    if (this.client) {
      this.log.appendLine(`[${ts()}] Disconnected.`);
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
      if (this.client) {
        // o servidor fechou a ligação sem avisar
        this.log.appendLine(`[${ts()}] The connection was closed by the server.`);
        this.disconnect();
      }
      return;
    }
    const cfg = getConfig();
    const idleMin = (Date.now() - this.lastActivity) / 60000;
    if (cfg.idleDisconnectMinutes > 0 && idleMin >= cfg.idleDisconnectMinutes) {
      this.log.appendLine(`[${ts()}] No activity for ${cfg.idleDisconnectMinutes} min: disconnecting.`);
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
        this.lastKeepAlive = Date.now();
        this.updateStatus();
      } catch (err) {
        this.log.appendLine(`[${ts()}] Keepalive failed: ${errText(err)}`);
        this.disconnect();
        vscode.window.showWarningMessage("Mainframe FTPS: the connection dropped. A new token will be asked for on the next operation.");
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
  run<T>(label: string, op: (client: Client) => Promise<T>, opts?: { quiet?: boolean }): Promise<T> {
    return this.enqueue(async () => {
      await this.ensureConnected();
      this.lastActivity = Date.now();
      try {
        return await op(this.client!);
      } catch (first) {
        let err = first;
        // Só a ligação de dados falhou: se a sessão responde, repete uma vez sem desligar.
        if (isDataSocketError(err) && this.client && !this.client.closed) {
          const alive = await this.client.send("NOOP").then(
            () => true,
            () => false
          );
          if (alive) {
            this.log.appendLine(`[${ts()}] ${label}: data connection failed (${errText(err)}); retrying.`);
            try {
              return await op(this.client!);
            } catch (second) {
              err = second;
              if (isDataSocketError(err) && this.client && !this.client.closed) {
                throw err; // a sessão continua ligada; o erro fica só nesta operação
              }
            }
          }
        }
        if (!isConnectionError(err, this.client)) {
          throw err;
        }
        this.log.appendLine(`[${ts()}] ${label}: connection lost (${errText(err)}).`);
        this.disconnect();
        if (opts?.quiet) {
          throw new CancelledError(); // verificações em segundo plano não perguntam nada
        }
        const again = await vscode.window.showWarningMessage(
          `The mainframe connection dropped during "${label}". Reconnect and retry?`,
          "Reconnect"
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
    return this.run(`save ${target}`, async (c) => {
      await c.send("TYPE A");
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      const res = await c.uploadFrom(Readable.from([data]), quoteDsn(target));
      this.log.appendLine(`[${ts()}] Saved ${target}: ${oneLine(res.message)}`);
      return res.message;
    });
  }

  async downloadText(target: string): Promise<Buffer> {
    return this.run(`read ${target}`, async (c) => {
      await c.send("TYPE A");
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      const sink = new BufferSink();
      await c.downloadTo(sink, quoteDsn(target));
      return sink.buffer();
    });
  }

  /**
   * Diz se um data set é uma biblioteca (PDS/PDSE) sem abrir ligação de dados:
   * o CWD para um PDS responde "... is a partitioned data set".
   */
  async isPartitioned(dsn: string): Promise<boolean> {
    return this.run(`check ${dsn}`, async (c) => {
      try {
        const res = await c.cd(quoteDsn(dsn));
        this.log.appendLine(`  > CWD ${quoteDsn(dsn)}  < ${res.code} ${firstLine(res.message)}`);
        return /partitioned/i.test(res.message);
      } catch (err) {
        if (err instanceof FTPError) {
          return false;
        }
        throw err;
      } finally {
        await this.cdHome(c);
      }
    });
  }

  /**
   * Listagem MVS de data sets (como o ISPF 3.4). Devolve o texto em bruto e o
   * diretório de trabalho usado, para completar nomes relativos.
   */
  async listDatasetsRaw(pattern: string, quiet = false): Promise<{ raw: string; cwd: string }> {
    return this.run(`list ${pattern}`, async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      const p = pattern.trim().toUpperCase().replace(/^'+|'+$/g, "");
      const wild = p.search(/[*%]/);
      const fixed = wild >= 0 ? p.slice(0, wild) : p;
      const dot = fixed.lastIndexOf(".");
      try {
        if (dot > 0) {
          const cwd = p.slice(0, dot + 1);
          await c.cd(`'${cwd}'`);
          return { raw: await rawList(c, `LIST ${p.slice(dot + 1) || "*"}`), cwd };
        }
        return { raw: await rawList(c, `LIST '${p}'`), cwd: "" };
      } catch (err) {
        if (err instanceof FTPError && err.code === 550) {
          return { raw: "", cwd: "" }; // nenhum data set
        }
        throw err;
      } finally {
        await this.cdHome(c);
      }
    }, { quiet });
  }

  /** Listagem dos membros de um PDS (com estatísticas ISPF quando existem). */
  async listMembersRaw(pds: string): Promise<string> {
    return this.run(`list ${pds}`, async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      await c.cd(quoteDsn(pds));
      try {
        return await rawList(c, "LIST");
      } catch (err) {
        if (err instanceof FTPError && err.code === 550) {
          return ""; // PDS vazio
        }
        throw err;
      } finally {
        await this.cdHome(c);
      }
    });
  }

  /** Lista só os nomes dos membros. */
  async listMembers(pds: string): Promise<string[]> {
    const raw = await this.listMembersRaw(pds);
    return raw
      .split(/\r?\n/)
      .map((l) => (l.trim().split(/\s+/)[0] ?? "").replace(/£/g, "#").replace(/[àÀ]/g, "@").toUpperCase())
      .filter((n) => n && n !== "NAME" && /^[A-Z#@$][A-Z0-9#@$]{0,7}$/.test(n));
  }

  /** Aloca um data set (PDS, PDSE ou sequencial). */
  async allocate(dsn: string, o: AllocOptions): Promise<void> {
    await this.run(`allocate ${dsn}`, async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      const blk = o.recfm.startsWith("V") ? 27998 : Math.floor(27998 / o.lrecl) * o.lrecl;
      await this.sendLogged(c, `SITE RECFM=${o.recfm} LRECL=${o.lrecl} BLKSIZE=${blk}`);
      await this.sendLogged(c, `SITE ${o.unit} PRIMARY=${o.primary} SECONDARY=${o.secondary}`);
      if (o.dsorg === "PO") {
        await this.sendLogged(c, `SITE DIRECTORY=${o.directory}`);
        await c.send(`SITE DSNTYPE=${o.pdse ? "LIBRARY" : "PDS"}`).catch(() => undefined);
        await this.sendLogged(c, `MKD ${quoteDsn(dsn)}`);
      } else {
        await c.send("SITE DSNTYPE=BASIC").catch(() => undefined);
        await c.send("TYPE A");
        await c.uploadFrom(Readable.from([Buffer.alloc(0)]), quoteDsn(dsn));
      }
      this.log.appendLine(`[${ts()}] Allocated ${dsn}`);
    });
  }

  /** Renomeia um data set ou membro (nomes completos, ex.: A.B(X) -> A.B(Y)). */
  async rename(from: string, to: string): Promise<void> {
    await this.run(`rename ${from}`, async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      await this.sendLogged(c, `RNFR ${quoteDsn(from)}`);
      await this.sendLogged(c, `RNTO ${quoteDsn(to)}`);
    });
  }

  /** Apaga um data set ou membro. */
  async remove(dsn: string): Promise<void> {
    await this.run(`delete ${dsn}`, async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=SEQ");
      await this.sendLogged(c, `DELE ${quoteDsn(dsn)}`);
    });
  }

  private async cdHome(c: Client): Promise<void> {
    await c.cd(`'${this.userId}.'`).catch(() => undefined);
  }

  /** Submete JCL ao JES. Devolve o JOBID. */
  async submit(jcl: Buffer): Promise<{ jobId: string; message: string }> {
    return this.run("submit job", async (c) => {
      await c.send("TYPE A");
      await this.sendLogged(c, "SITE FILETYPE=JES");
      try {
        const res = await c.uploadFrom(Readable.from([jcl]), "SUBMIT.JCL");
        const m = /\b(J(?:OB)?\d{5,7})\b/i.exec(res.message);
        this.log.appendLine(`[${ts()}] Submit: ${oneLine(res.message)}`);
        if (!m) {
          throw new Error(`Could not get the JOBID: ${res.message}`);
        }
        return { jobId: m[1].toUpperCase(), message: res.message };
      } finally {
        await c.send("SITE FILETYPE=SEQ").catch(() => undefined);
      }
    });
  }

  /**
   * Acesso a um job pelo JOBID. O z/OS aplica o filtro JESJOBNAME (por omissão
   * <userid>*) mesmo em LIST/RETR/DELE de um JOBID, por isso jobs com outro nome
   * (ex.: IXXXXXTT) davam "550 Jobid not found". O dono continua a ser o utilizador.
   */
  private async jesById(c: Client): Promise<void> {
    await this.sendLogged(c, "SITE JESJOBNAME=*");
    await this.sendLogged(c, `SITE JESOWNER=${this.userId}`);
  }

  /** Listagem JES em bruto (LIST <jobid> ou LIST de todos os jobs com filtro). */
  async jesList(jobIdOrEmpty: string, jobNameFilter = "*", owner = ""): Promise<string> {
    return this.run("job status", async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=JES");
      try {
        if (jobIdOrEmpty) {
          await this.jesById(c);
        } else {
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
        await this.jesById(c);
        const sink = new BufferSink();
        await c.downloadTo(sink, `${jobId}.x`);
        return sink.buffer();
      } finally {
        await c.send("SITE FILETYPE=SEQ").catch(() => undefined);
      }
    });
  }

  /** Lista de ficheiros de spool (LIST jobid) e o spool completo (RETR jobid.x), na mesma operação. */
  async spoolWithList(jobId: string): Promise<{ list: string; data: Buffer }> {
    return this.run(`spool ${jobId}`, async (c) => {
      await c.send("TYPE A");
      await this.sendLogged(c, "SITE FILETYPE=JES");
      try {
        await this.jesById(c);
        let list = "";
        try {
          list = await rawList(c, `LIST ${jobId}`);
        } catch (err) {
          if (!(err instanceof FTPError && err.code === 550)) {
            throw err;
          }
        }
        const sink = new BufferSink();
        await c.downloadTo(sink, `${jobId}.x`);
        return { list, data: sink.buffer() };
      } finally {
        await c.send("SITE FILETYPE=SEQ").catch(() => undefined);
      }
    });
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.run(`purge ${jobId}`, async (c) => {
      await this.sendLogged(c, "SITE FILETYPE=JES");
      try {
        await this.jesById(c);
        await this.sendLogged(c, `DELE ${jobId}`);
      } finally {
        await c.send("SITE FILETYPE=SEQ").catch(() => undefined);
      }
    });
  }

  // ------------------------------------------------------------------- UI

  private updateStatus(): void {
    const cfg = getConfig();
    const connected = this.isConnected;
    const several = servers().length > 1;
    const name = this.server;
    const label = name ? ` ${name}` : "";
    vscode.commands.executeCommand("setContext", "mainframeFtps.connected", connected);
    vscode.commands.executeCommand("setContext", "mainframeFtps.multipleServers", several);
    const tip = new vscode.MarkdownString(undefined, true);
    if (connected) {
      this.statusItem.text = `$(pass-filled) MF${label}`;
      this.statusItem.color = new vscode.ThemeColor("mainframeFtps.connectedForeground");
      tip.appendMarkdown(`**$(pass-filled) Authenticated** as \`${this.userId}\` on **${name}** (\`${cfg.host}:${cfg.port}\`)\n\n`);
      tip.appendMarkdown(`Connected since ${hhmm(this.connectedSince)} · last keepalive ${hhmmss(this.lastKeepAlive)}\n\n`);
      tip.appendMarkdown(several ? "Click to switch server or disconnect" : "Click to disconnect");
      this.statusItem.command = several ? "mainframeFtps.selectServer" : "mainframeFtps.disconnect";
    } else if (this.connecting) {
      this.statusItem.text = `$(sync~spin) MF${label} connecting…`;
      this.statusItem.color = undefined;
      tip.appendMarkdown(`Authenticating on ${name || "mainframe"}…`);
      this.statusItem.command = undefined;
    } else {
      this.statusItem.text = `$(circle-large-outline) MF${label}`;
      this.statusItem.color = new vscode.ThemeColor("mainframeFtps.disconnectedForeground");
      tip.appendMarkdown(`**$(circle-large-outline) Not authenticated**${name ? ` · next server: **${name}**` : ""}\n\n`);
      tip.appendMarkdown(several ? "Click to choose the server and connect (asks for PIN + token)" : "Click to connect (asks for PIN + token)");
      this.statusItem.command = several ? "mainframeFtps.selectServer" : "mainframeFtps.connect";
    }
    tip.appendMarkdown(`\n\n---\n\n$(folder) Local folder: \`${localBase(this.context).fsPath}\``);
    this.statusItem.backgroundColor = undefined;
    this.statusItem.tooltip = tip;
  }

  /** Texto curto do estado, para as vistas. */
  get stateLabel(): string {
    return this.isConnected ? `🟢 ${this.userId}@${this.serverName}` : `○ disconnected${this.server ? ` · ${this.server}` : ""}`;
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
    super("Cancelled");
  }
}

export interface AllocOptions {
  dsorg: "PO" | "PS";
  pdse: boolean;
  recfm: string;
  lrecl: number;
  unit: "TRACKS" | "CYLINDERS";
  primary: number;
  secondary: number;
  directory: number;
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

/**
 * As ligações de dados do z/OS têm de retomar a sessão TLS. Em TLS 1.3 cada "bilhete"
 * de sessão só serve uma vez; o basic-ftp guardava só o último (FtpContext.tlsSessionStore)
 * e, se o bilhete da ligação anterior ainda não tinha chegado, reutilizava um já gasto:
 * o servidor recusava ("534 TLS negotiation failed" ou ECONNRESET). Aqui os bilhetes
 * recebidos (controlo e dados) ficam numa fila e cada ligação de dados usa um novo.
 */
export function pinControlSession(client: Client, log?: (s: string) => void): void {
  const ftp = client.ftp as any;
  const control = ftp.socket as tls.TLSSocket;
  if (typeof control.getSession !== "function") {
    return;
  }
  // Um erro só na ligação de dados (ex.: o RACF recusa a listagem de um data set sem acesso e o
  // servidor corta a ligação) fecharia a sessão inteira. Fica só na operação; a sessão continua.
  const origSetup = ftp._setupDefaultErrorHandlers;
  ftp._setupDefaultErrorHandlers = function (socket: any, identifier: string) {
    if (identifier !== "data socket") {
      return origSetup.call(this, socket, identifier);
    }
    socket.on("error", (e: Error) => {
      e.message += ` (${identifier})`;
    });
    socket.once("timeout", () => {
      socket.destroy();
    });
  };
  const unused: Buffer[] = [];
  const first = control.getSession();
  if (first) {
    unused.push(first);
  }
  control.on("session", (s: Buffer) => unused.push(s));
  let last: Buffer | undefined = first;
  Object.defineProperty(ftp, "tlsSessionStore", {
    configurable: true,
    get: () => {
      const next = unused.shift();
      if (next) {
        last = next;
        return next;
      }
      if (control.getProtocol() === "TLSv1.3") {
        log?.("  TLS: no unused session ticket, reusing the last one"); // em TLS 1.2 é o normal
      }
      return last;
    },
    set: (s: Buffer | undefined) => {
      if (s) {
        unused.push(s); // bilhete enviado numa ligação de dados
      }
    },
  });
}

/** Erro só na ligação de dados (listagem/transferência); a sessão pode continuar viva. */
function isDataSocketError(err: unknown): boolean {
  return /data socket/i.test(errText(err));
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

function hhmm(t: number): string {
  return new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function hhmmss(t: number): string {
  return new Date(t).toLocaleTimeString("en-GB");
}

function ts(): string {
  return new Date().toLocaleTimeString("en-GB");
}
