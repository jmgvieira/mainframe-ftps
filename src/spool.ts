/**
 * Formatação do spool de um job, ao estilo do SDSF:
 * resumo com o RC de cada step no topo e um cabeçalho por DD
 * (usado pelo Outline, pelo breadcrumb e para dobrar secções).
 *
 * Funções puras, sem dependência do vscode, para poderem ser testadas à parte.
 */

export interface SpoolFile {
  id: string; // 001, 002, ...
  step: string; // JES2, STEP01, ...
  procStep: string;
  cls: string;
  ddName: string;
  bytes: number;
}

export interface StepResult {
  step: string;
  procStep: string;
  result: string; // 0000, S0C7, U0100, FLUSH, ...
}

export interface SpoolSection {
  file: SpoolFile;
  text: string;
}

/** Linha de cabeçalho de cada DD no documento. */
export const HEADER_PREFIX = "=== ";
export const HEADER_RE = /^=== (\S+)(?: \| ([^|]*?))? \| #(\d{3}) =*$/;
export const SUMMARY_TITLE = "=== SUMMARY ";

const END_OF_FILE = /^\s*!! END OF JES SPOOL FILE !!\s*$/;

/**
 * Lista de ficheiros de spool de um "LIST JOBnnnnn" (JESINTERFACELEVEL=2):
 *          001 JES2              K JESMSGLG      1234
 *          004 STEP01   PROC1    A SYSPRINT       345
 */
export function parseSpoolFiles(raw: string): SpoolFile[] {
  const out: SpoolFile[] = [];
  const re = /^\s*(\d{3})\s+(\S+)\s+(?:(\S+)\s+)?(\S)\s+(\S+)\s+(\d+)\s*$/;
  for (const line of raw.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      out.push({
        id: m[1],
        step: m[2],
        procStep: m[3] ?? "",
        cls: m[4],
        ddName: m[5],
        bytes: parseInt(m[6], 10),
      });
    }
  }
  return out;
}

/** Divide o resultado de "RETR JOBnnnnn.x" nos ficheiros de spool. */
export function splitSpool(text: string): string[] {
  const parts: string[] = [];
  let cur: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (END_OF_FILE.test(line)) {
      parts.push(cur.join("\n"));
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.some((l) => l.trim())) {
    parts.push(cur.join("\n"));
  }
  return parts;
}

/** Associa cada parte do spool ao respetivo DD (pela ordem da listagem). */
export function sections(files: SpoolFile[], parts: string[]): SpoolSection[] {
  return parts.map((text, i) => ({
    text,
    file: files[i] ?? {
      id: String(i + 1).padStart(3, "0"),
      step: "",
      procStep: "",
      cls: "",
      ddName: `FICHEIRO${i + 1}`,
      bytes: 0,
    },
  }));
}

/**
 * Remove o carácter de controlo de impressão ASA da coluna 1, se o ficheiro o tiver.
 * Heurística: todas as linhas começam por ' ', '0', '1', '-' ou '+' e há pelo menos um '1' ou '0'.
 * '0' = linha em branco antes, '-' = duas linhas em branco antes, '+' = sobreimpressão (ignorada).
 */
export function stripAsa(text: string): string {
  const lines = text.split("\n");
  const content = lines.filter((l) => l.length > 0);
  if (!content.length || !content.every((l) => " 01-+".includes(l[0]))) {
    return text;
  }
  if (!content.some((l) => l[0] === "1" || l[0] === "0")) {
    return text;
  }
  const out: string[] = [];
  for (const l of lines) {
    const cc = l[0];
    const rest = l.slice(1);
    if (cc === "+") {
      continue;
    }
    if (cc === "0") {
      out.push("");
    } else if (cc === "-") {
      out.push("", "");
    }
    out.push(rest);
  }
  return out.join("\n");
}

/**
 * RC de cada step, a partir das mensagens do sistema:
 *   IEF142I JOB STEP01 - STEP WAS EXECUTED - COND CODE 0004
 *   IEF450I JOB STEP02 - ABEND=S0C7 U0000 REASON=00000000
 *   IEF272I JOB STEP03 - STEP WAS NOT EXECUTED.
 */
export function stepResults(text: string): StepResult[] {
  const out: StepResult[] = [];
  const add = (names: string, result: string) => {
    // "jobname step [procstep]" – o primeiro é o nome do job; os restantes mostram-se como vêm
    const t = names.trim().split(/\s+/).slice(1);
    out.push({ step: t.join("."), procStep: "", result });
  };
  for (const line of text.split("\n")) {
    let m = /IEF142I\s+(.+?)\s+-\s+STEP WAS EXECUTED\s+-\s+COND CODE\s+(\d{4})/.exec(line);
    if (m) {
      add(m[1], m[2]);
      continue;
    }
    m = /IEF450I\s+(.+?)\s+-\s+ABEND=(S[0-9A-F]{3})\s+(U\d{4})/.exec(line);
    if (m) {
      add(m[1], m[2] !== "S000" ? m[2] : m[3]);
      continue;
    }
    m = /IEF272I\s+(.+?)\s+-\s+STEP WAS NOT EXECUTED/.exec(line);
    if (m) {
      add(m[1], "FLUSH");
    }
  }
  return out;
}

export function headerLine(f: SpoolFile): string {
  const where = [f.step, f.procStep].filter(Boolean).join(" ");
  const base = `${HEADER_PREFIX}${f.ddName}${where ? ` | ${where}` : ""} | #${f.id} `;
  return base.padEnd(80, "=");
}

export interface SpoolHeader {
  jobName: string;
  jobId: string;
  owner?: string;
  status?: string;
  result?: string;
  readAt: Date;
}

/** Documento final: resumo + cada DD com o seu cabeçalho. */
export function formatSpool(h: SpoolHeader, secs: SpoolSection[], removeAsa: boolean): string {
  const body = secs.map((s) => ({ ...s, text: removeAsa ? stripAsa(s.text) : s.text }));
  const steps = stepResults(body.map((s) => s.text).join("\n"));
  const out: string[] = [];
  const hora = h.readAt.toLocaleString("en-GB");
  out.push(`${SUMMARY_TITLE}`.padEnd(80, "="));
  out.push(`JOB ${h.jobName}  ${h.jobId}${h.owner ? `  ${h.owner}` : ""}   ${h.status ?? ""} ${h.result ?? ""}`.trimEnd());
  out.push(`Read at ${hora}`);
  out.push("");
  if (steps.length) {
    out.push("STEP               RC");
    for (const s of steps) {
      const rc =
        s.result === "FLUSH" ? "FLUSH (not executed)" : /^\d{4}$/.test(s.result) ? `RC ${s.result}` : `ABEND ${s.result}`;
      out.push(`${s.step.padEnd(17)}  ${rc}`);
    }
  } else {
    out.push("(no IEF142I/IEF450I messages – job still running or JCL error)");
  }
  out.push("");
  out.push("DD        STEP      BYTES");
  for (const s of body) {
    out.push(`${s.file.ddName.padEnd(8)}  ${s.file.step.padEnd(8)}  ${s.file.bytes || ""}`.trimEnd());
  }
  out.push("");
  for (const s of body) {
    out.push(headerLine(s.file));
    out.push(s.text.replace(/\s+$/, ""));
    out.push("");
  }
  return out.join("\n");
}

/** Secções do documento já formatado (para Outline e dobrar). */
export function documentSections(lines: string[]): Array<{ name: string; detail: string; id: string; start: number; end: number }> {
  const heads: Array<{ name: string; detail: string; id: string; start: number }> = [];
  lines.forEach((l, i) => {
    if (l.startsWith(SUMMARY_TITLE)) {
      heads.push({ name: "Summary", detail: "", id: "000", start: i });
      return;
    }
    const m = HEADER_RE.exec(l);
    if (m) {
      heads.push({ name: m[1], detail: (m[2] ?? "").trim(), id: m[3], start: i });
    }
  });
  return heads.map((h, k) => {
    let end = k + 1 < heads.length ? heads[k + 1].start - 1 : lines.length - 1;
    while (end > h.start && !lines[end].trim()) {
      end--;
    }
    return { ...h, end };
  });
}
