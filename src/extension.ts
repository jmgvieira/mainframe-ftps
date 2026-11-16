import * as vscode from "vscode";
import * as path from "path";
import { FtpSession, CancelledError, errText } from "./session";
import { TargetMap, IGNORE, validateDsn, validateMember, suggestMember, pdsOf, memberOf } from "./mapping";
import { JobsProvider, JobInfo, parseJobList, parseJobLine, severity } from "./jobs";
import { getConfig } from "./config";
import { DatasetsProvider } from "./datasets";
import { registerBrowse } from "./browse";
import { encode, decode, unsupported } from "./codec";
import { parseSpoolFiles, splitSpool, sections, formatSpool, documentSections } from "./spool";

let session: FtpSession;
let targets: TargetMap;
let jobs: JobsProvider;
let log: vscode.OutputChannel;
let datasets: DatasetsProvider;
const spoolChanged = new vscode.EventEmitter<vscode.Uri>();

const SPOOL_SCHEME = "mfspool";

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("Mainframe FTPS");
  session = new FtpSession(context, log);
  targets = new TargetMap(context);
  jobs = new JobsProvider(context, session, log);

  datasets = new DatasetsProvider(session);
  const tree = vscode.window.createTreeView("mainframeFtps.jobs", { treeDataProvider: jobs });
  vscode.commands.executeCommand("setContext", "mainframeFtps.connected", false);

  const submitJcl = async (data: Buffer, jobName: string, source: string) => {
    const { jobId } = await session.submit(data);
    const job = await jobs.add(jobId, jobName, source);
    tree.reveal(job, { select: true, focus: false }).then(undefined, () => undefined);
    vscode.window.setStatusBarMessage(`$(rocket) ${jobName} ${jobId} submetido`, 5000);
    log.appendLine(`Job ${jobName} ${jobId} submetido a partir de ${source}`);
  };

  // Spool como documento só de leitura: mfspool:/JOB12345/NOME.spool (um separador por job)
  const spoolProvider: vscode.TextDocumentContentProvider = {
    onDidChange: spoolChanged.event,
    async provideTextDocumentContent(uri) {
      const jobId = uri.path.split("/")[1];
      const jobName = path.basename(uri.path, ".spool");
      try {
        const { list, data } = await session.spoolWithList(jobId);
        const cfg = getConfig();
        const text = decode(data, cfg.transferEncoding).replace(/\r\n/g, "\n");
        const info = parseJobLine(list, jobId);
        const owner = list.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((t) => t[1] === jobId)?.[2];
        return formatSpool(
          { jobName: info?.jobName ?? jobName, jobId, owner, status: info?.status, result: info?.result, readAt: new Date() },
          sections(parseSpoolFiles(list), splitSpool(text)),
          cfg.spoolStripAsa
        );
      } catch (err) {
        return `Não foi possível obter o spool de ${jobId}:\n${errText(err)}\n\n` +
          "O job pode já ter sido apagado do JES (purge). Use \"Atualizar estado\" na vista Jobs para confirmar.";
      }
    },
  };

  // Outline / breadcrumb e dobrar por DD
  const spoolSelector: vscode.DocumentSelector = { language: "mfspool" };
  const symbolProvider: vscode.DocumentSymbolProvider = {
    provideDocumentSymbols(doc) {
      const lines = doc.getText().split("\n");
      return documentSections(lines).map((s) => {
        const range = new vscode.Range(s.start, 0, s.end, lines[s.end]?.length ?? 0);
        return new vscode.DocumentSymbol(
          s.name,
          s.detail,
          s.id === "000" ? vscode.SymbolKind.Namespace : vscode.SymbolKind.File,
          range,
          new vscode.Range(s.start, 0, s.start, lines[s.start].length)
        );
      });
    },
  };
  const foldingProvider: vscode.FoldingRangeProvider = {
    provideFoldingRanges(doc) {
      return documentSections(doc.getText().split("\n"))
        .filter((s) => s.end > s.start)
        .map((s) => new vscode.FoldingRange(s.start, s.end, vscode.FoldingRangeKind.Region));
    },
  };

  context.subscriptions.push(
    log,
    session,
    jobs,
    tree,
    vscode.workspace.registerTextDocumentContentProvider(SPOOL_SCHEME, spoolProvider),
    vscode.languages.registerDocumentSymbolProvider(spoolSelector, symbolProvider, { label: "Spool" }),
    vscode.languages.registerFoldingRangeProvider(spoolSelector, foldingProvider),
    spoolChanged,
    session.onDidChangeState((up) => up && jobs.refreshAll()),

    vscode.workspace.onDidSaveTextDocument((doc) => onSave(doc)),

    cmd("mainframeFtps.connect", async () => {
      await session.ensureConnected();
      vscode.window.setStatusBarMessage("$(plug) Ligado ao mainframe", 3000);
    }),
    cmd("mainframeFtps.disconnect", async () => session.disconnect()),
    cmd("mainframeFtps.forgetPin", async () => {
      await session.forgetPin();
      vscode.window.showInformationMessage("PIN esquecido.");
    }),
    cmd("mainframeFtps.upload", async (uri?: vscode.Uri) => {
      const doc = await docFor(uri);
      let target = await targets.get(doc.uri);
      if (!target || target === IGNORE) {
        target = await askTarget(doc.uri);
      }
      await upload(doc, target);
    }),
    cmd("mainframeFtps.setTarget", async (uri?: vscode.Uri) => {
      const doc = await docFor(uri);
      const target = await askTarget(doc.uri);
      vscode.window.showInformationMessage(`Destino de ${path.basename(doc.fileName)}: ${target}`);
    }),
    cmd("mainframeFtps.clearTarget", async (uri?: vscode.Uri) => {
      const doc = await docFor(uri);
      await targets.set(doc.uri, undefined);
      vscode.window.showInformationMessage(`Destino removido de ${path.basename(doc.fileName)}.`);
    }),
    cmd("mainframeFtps.submit", async (uri?: vscode.Uri) => {
      const doc = await docFor(uri);
      if (doc.isDirty) {
        await doc.save(); // dispara também a gravação no mainframe
      }
      const data = await prepareText(doc, "submeter");
      const jobName = /^\/\/(\S+)\s+JOB\b/m.exec(doc.getText())?.[1]?.toUpperCase() ?? "";
      await submitJcl(data, jobName, path.basename(doc.fileName));
    }),
    cmd("mainframeFtps.jobStatus", async (job?: JobInfo) => {
      job = job ?? (await pickJob());
      if (!job) {
        return;
      }
      await jobs.refresh(job);
      const sev = severity(job);
      const msg = `${job.jobName} ${job.jobId}: ${job.status} ${job.result}`.trim();
      const show = sev === "error" ? vscode.window.showErrorMessage
        : sev === "warn" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      const action = await show(msg, ...(job.status === "OUTPUT" ? ["Ver spool"] : []));
      if (action) {
        await openSpool(job);
      }
    }),
    cmd("mainframeFtps.openSpool", async (job?: JobInfo, ddId?: string) => {
      job = job ?? (await pickJob());
      if (job) {
        await openSpool(job, ddId);
      }
    }),
    cmd("mainframeFtps.refreshJobs", async () => {
      await session.ensureConnected();
      for (const j of jobs.all()) {
        await jobs.refresh(j).catch(() => undefined);
      }
    }),
    cmd("mainframeFtps.clearJobs", async () => jobs.clear()),
    cmd("mainframeFtps.removeJob", async (job: JobInfo) => job && jobs.remove(job)),
    cmd("mainframeFtps.purgeJob", async (job: JobInfo) => {
      if (!job) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Apagar ${job.jobName} ${job.jobId} do JES (purge do spool)?`, { modal: true }, "Apagar"
      );
      if (ok) {
        await session.deleteJob(job.jobId);
        await jobs.remove(job);
      }
    }),
    cmd("mainframeFtps.listJobs", async () => {
      const filter = await vscode.window.showInputBox({
        title: "Listar jobs no JES",
        prompt: "Filtro do nome do job (ex.: USER*, * para todos os seus)",
        value: "*",
        ignoreFocusOut: true,
      });
      if (filter === undefined) {
        return;
      }
      const raw = await session.jesList("", filter.toUpperCase() || "*");
      const list = parseJobList(raw);
      if (!list.length) {
        vscode.window.showInformationMessage("Nenhum job encontrado.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        list.map((j) => ({
          label: `${j.jobName}  ${j.jobId}`,
          description: `${j.status} ${j.result ?? ""}`,
          job: j,
        })),
        { title: "Jobs no JES", placeHolder: "Escolha um job para ver o spool" }
      );
      if (pick) {
        const job: JobInfo = {
          jobId: pick.job.jobId, jobName: pick.job.jobName ?? "", status: pick.job.status ?? "?",
          result: pick.job.result ?? "", submitted: Date.now(),
        };
        await openSpool(job);
      }
    }),
    cmd("mainframeFtps.openMember", async () => openMember(context)),
    cmd("mainframeFtps.showLog", async () => log.show()),
    datasets,
    ...registerBrowse({ context, session, targets, datasets, log, submit: submitJcl, cmd }),
  );
}

export function deactivate() {
  session?.disconnect();
}

// --------------------------------------------------------------------- gravar

async function onSave(doc: vscode.TextDocument): Promise<void> {
  const cfg = getConfig();
  if (!cfg.autoUploadOnSave || doc.uri.scheme !== "file") {
    return;
  }
  const ext = path.extname(doc.fileName).toLowerCase();
  let target = await targets.get(doc.uri);
  if (target === IGNORE) {
    return;
  }
  if (!target) {
    if (!cfg.fileExtensions.includes(ext)) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Gravar ${path.basename(doc.fileName)} também no mainframe?`,
      "Escolher destino (PDS)…",
      "Nunca para este ficheiro"
    );
    if (choice === "Nunca para este ficheiro") {
      await targets.set(doc.uri, IGNORE);
      return;
    }
    if (!choice) {
      return;
    }
    try {
      target = await askTarget(doc.uri);
    } catch (err) {
      if (err instanceof CancelledError) {
        return;
      }
      throw err;
    }
  }
  try {
    await upload(doc, target);
  } catch (err) {
    if (err instanceof CancelledError) {
      vscode.window.setStatusBarMessage("Mainframe: gravação cancelada", 4000);
      return;
    }
    log.appendLine(`Erro a gravar ${target}: ${errText(err)}`);
    const a = await vscode.window.showErrorMessage(`Erro a gravar ${target}: ${errText(err)}`, "Tentar de novo", "Ver log");
    if (a === "Tentar de novo") {
      await onSave(doc);
    } else if (a === "Ver log") {
      log.show();
    }
  }
}

async function upload(doc: vscode.TextDocument, target: string): Promise<void> {
  const data = await prepareText(doc, "gravar");
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `A gravar ${target}…` },
    () => session.uploadText(target, data)
  );
  vscode.window.setStatusBarMessage(`$(cloud-upload) Gravado em ${target}`, 4000);
  if (memberOf(target)) {
    datasets.refreshPds(pdsOf(target));
  }
}

/** Converte o texto do editor em registos para o mainframe, avisando de problemas. */
async function prepareText(doc: vscode.TextDocument, action: string): Promise<Buffer> {
  const cfg = getConfig();
  const tabSize = Number(vscode.workspace.getConfiguration("editor", doc.uri).get("tabSize", 4)) || 4;
  const lines = doc.getText().replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => expandTabs(l, tabSize));

  const long = lines.map((l, i) => ({ n: i + 1, len: l.length })).filter((x) => x.len > cfg.recordLength);
  if (long.length) {
    const sample = long.slice(0, 5).map((x) => `linha ${x.n} (${x.len})`).join(", ");
    const ok = await vscode.window.showWarningMessage(
      `${long.length} linha(s) com mais de ${cfg.recordLength} colunas: ${sample}. ` +
        "No mainframe podem ser truncadas ou partidas.",
      { modal: true },
      `${capitalize(action)} mesmo assim`
    );
    if (!ok) {
      throw new CancelledError();
    }
  }

  const text = lines.join("\r\n") + "\r\n";
  const bad = unsupported(text, cfg.transferEncoding);
  if (bad.length) {
    const ok = await vscode.window.showWarningMessage(
      `O ficheiro tem caracteres que não existem no código de página do mainframe (${cfg.hostCodePage || cfg.transferEncoding}): ${bad.join(" ")}. Serão enviados como "?".`,
      { modal: true },
      `${capitalize(action)} mesmo assim`
    );
    if (!ok) {
      throw new CancelledError();
    }
  }
  return encode(text, cfg.transferEncoding);
}

async function askTarget(uri: vscode.Uri): Promise<string> {
  const current = await targets.get(uri);
  const lastPds = current && current !== IGNORE ? pdsOf(current) : await targets.lastPds(uri);
  const pds = await vscode.window.showInputBox({
    title: `Destino no mainframe – ${path.basename(uri.fsPath)} (1/2)`,
    prompt: "Biblioteca (PDS), ex.: USER.JCL.LIB",
    value: lastPds,
    ignoreFocusOut: true,
    validateInput: validateDsn,
  });
  if (!pds) {
    throw new CancelledError();
  }
  const currentMember = current && current !== IGNORE ? memberOf(current) : "";
  const member = await vscode.window.showInputBox({
    title: `Destino no mainframe – ${path.basename(uri.fsPath)} (2/2)`,
    prompt: `Membro em ${pds.toUpperCase()}`,
    value: currentMember || suggestMember(uri.fsPath),
    ignoreFocusOut: true,
    validateInput: validateMember,
  });
  if (!member) {
    throw new CancelledError();
  }
  const target = `${pds.trim().toUpperCase().replace(/^'|'$/g, "")}(${member.trim().toUpperCase()})`;
  await targets.set(uri, target);
  return target;
}

// ---------------------------------------------------------------- membros

async function openMember(_context: vscode.ExtensionContext): Promise<void> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const pds = await vscode.window.showInputBox({
    title: "Abrir membro do mainframe",
    prompt: "Biblioteca (PDS)",
    value: active ? await targets.lastPds(active) : "",
    ignoreFocusOut: true,
    validateInput: validateDsn,
  });
  if (!pds) {
    return;
  }
  const dsn = pds.trim().toUpperCase().replace(/^'|'$/g, "");
  const members = await session.listMembers(dsn);
  const member = await vscode.window.showQuickPick(members, {
    title: `${dsn} – ${members.length} membros`,
    placeHolder: "Escolha o membro",
  });
  if (!member) {
    return;
  }
  const target = `${dsn}(${member})`;
  const ext = await vscode.window.showQuickPick([".jcl", ".ezt", ".cbl", ".cpy", ".txt"], {
    title: "Extensão do ficheiro local",
  });
  if (!ext) {
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const dest = await vscode.window.showSaveDialog({
    defaultUri: root ? vscode.Uri.joinPath(root, member + ext) : undefined,
    title: `Guardar ${target} como…`,
  });
  if (!dest) {
    return;
  }
  const buf = await session.downloadText(target);
  const text = decode(buf, getConfig().transferEncoding).replace(/\r\n/g, "\n");
  await vscode.workspace.fs.writeFile(dest, Buffer.from(text, "utf8"));
  await targets.set(dest, target);
  await vscode.window.showTextDocument(dest);
  vscode.window.setStatusBarMessage(`$(cloud-download) ${target} aberto (associado a este ficheiro)`, 5000);
}

// ------------------------------------------------------------------ jobs

/**
 * Abre o spool num separador por job. Se já estiver aberto, volta a ler do JES
 * no mesmo separador. Com ddId, posiciona no início desse DD.
 */
async function openSpool(job: JobInfo, ddId?: string): Promise<void> {
  const uri = vscode.Uri.from({
    scheme: SPOOL_SCHEME,
    path: `/${job.jobId}/${job.jobName || job.jobId}.spool`,
  });
  const existing = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  let doc: vscode.TextDocument;
  if (existing && !ddId) {
    // atualizar: espera pelo novo conteúdo
    const updated = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === uri.toString()) {
          sub.dispose();
          resolve();
        }
      });
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, 15000);
    });
    spoolChanged.fire(uri);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `A ler o spool de ${job.jobId}…` },
      () => updated
    );
    doc = existing;
  } else {
    doc = existing ?? (await vscode.workspace.openTextDocument(uri));
  }
  if (doc.languageId !== "mfspool") {
    doc = await vscode.languages.setTextDocumentLanguage(doc, "mfspool");
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (ddId) {
    const lines = doc.getText().split("\n");
    const sec = documentSections(lines).find((s) => s.id === ddId);
    if (sec) {
      const pos = new vscode.Position(sec.start, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
    }
  }
}

async function pickJob(): Promise<JobInfo | undefined> {
  const items: Array<vscode.QuickPickItem & { job?: JobInfo }> = jobs.all().map((j) => ({
    label: `${j.jobName}  ${j.jobId}`,
    description: `${j.status} ${j.result}`,
    detail: j.source,
    job: j,
  }));
  items.push({ label: "$(search) Outro JOBID…" });
  const pick = await vscode.window.showQuickPick(items, { title: "Escolha o job" });
  if (!pick) {
    return undefined;
  }
  if (pick.job) {
    return pick.job;
  }
  const id = await vscode.window.showInputBox({
    prompt: "JOBID (ex.: JOB12345)",
    validateInput: (v) => (/^(J(OB)?|T(SU)?|S(TC)?)\d{5,7}$/i.test(v.trim()) ? undefined : "JOBID inválido"),
  });
  if (!id) {
    return undefined;
  }
  const jobId = id.trim().toUpperCase();
  const parsed = parseJobLine(await session.jesList(jobId), jobId);
  return { jobId, jobName: parsed?.jobName ?? "", status: parsed?.status ?? "?", result: parsed?.result ?? "", submitted: Date.now() };
}

// ------------------------------------------------------------- utilitários

function cmd(id: string, fn: (...args: any[]) => Promise<unknown>): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof CancelledError) {
        return;
      }
      log.appendLine(`Erro em ${id}: ${errText(err)}`);
      const a = await vscode.window.showErrorMessage(`Mainframe FTPS: ${errText(err)}`, "Ver log");
      if (a) {
        log.show();
      }
    }
  });
}

async function docFor(uri?: vscode.Uri): Promise<vscode.TextDocument> {
  if (uri instanceof vscode.Uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    throw new Error("Abra primeiro um ficheiro no editor.");
  }
  return doc;
}

function expandTabs(line: string, size: number): string {
  if (!line.includes("\t")) {
    return line;
  }
  let out = "";
  for (const ch of line) {
    if (ch === "\t") {
      out += " ".repeat(size - (out.length % size));
    } else {
      out += ch;
    }
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
