// Leitura simples de JCL: steps, DDs e data sets referidos.
// Sem dependências do VS Code, para se poder testar com node.

export interface JclDd {
  /** Nome do DD (nas concatenações repete o do DD anterior). */
  ddName: string;
  /** Nome completo como escrito, depois de resolver os símbolos: PDS(MEMBRO), GDG(+1)… */
  dsn: string;
  /** Nome do data set sem membro nem geração. */
  base: string;
  member?: string;
  /** Geração relativa de um GDG: 0, +1, -1… */
  gdg?: string;
  /** Primeiro parâmetro do DISP (NEW quando não é indicado). */
  disp: string;
  /** Linha da instrução DD (0 = primeira). */
  line: number;
  /** DD sem nome, a seguir a outro (concatenação). */
  concat: boolean;
  /** Ficou algum símbolo &X por resolver. */
  unresolved: boolean;
}

export interface JclStep {
  /** Nome do step; "JOB" para JCLLIB/JOBLIB. */
  name: string;
  /** PGM=…, nome do procedimento, ou JCLLIB/JOBLIB. */
  exec: string;
  line: number;
  /** true para o grupo do job (JCLLIB, JOBLIB). */
  job: boolean;
  dds: JclDd[];
}

export interface JclInfo {
  jobName: string;
  steps: JclStep[];
}

interface Stmt {
  name: string;
  op: string;
  operands: string;
  line: number;
}

/** Campo de operandos: até ao primeiro espaço fora de plicas. */
function operandField(s: string): string {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      q = !q;
    } else if (ch === " " && !q) {
      return s.slice(0, i);
    }
  }
  return s;
}

/** Divide por vírgulas ao nível de topo (fora de parênteses e plicas). */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = false;
  let cur = "";
  for (const ch of s) {
    if (ch === "'") {
      q = !q;
    } else if (!q && ch === "(") {
      depth++;
    } else if (!q && ch === ")") {
      depth--;
    } else if (!q && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function keywords(operands: string): { pos: string[]; kw: Map<string, string> } {
  const pos: string[] = [];
  const kw = new Map<string, string>();
  for (const p of splitTop(operands)) {
    const m = /^([A-Z0-9#@$.]+)=(.*)$/is.exec(p);
    if (m) {
      kw.set(m[1].toUpperCase(), m[2]);
    } else if (p) {
      pos.push(p);
    }
  }
  return { pos, kw };
}

function unquote(v: string): string {
  return v.length >= 2 && v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v;
}

/** Substitui &SIMB e &SIMB. pelos valores conhecidos (não toca em &&TEMP). */
export function resolveSymbols(s: string, sym: Map<string, string>): string {
  return s.replace(/(?<!&)&([A-Z#@$][A-Z0-9#@$]{0,7})(\.?)/gi, (all, name: string, dot: string) => {
    const v = sym.get(name.toUpperCase());
    return v === undefined ? all : v;
  });
}

/** Junta as linhas em instruções, saltando comentários e dados instream. */
function statements(text: string): Stmt[] {
  const out: Stmt[] = [];
  const lines = text.split(/\r?\n/);
  let cur: Stmt | undefined;
  let instream: { dlm: string; slashEnds: boolean } | undefined;

  const finish = () => {
    if (!cur) {
      return;
    }
    out.push(cur);
    if (cur.op === "DD") {
      const { pos, kw } = keywords(cur.operands);
      const first = (pos[0] ?? "").toUpperCase();
      if (first === "*" || first === "DATA") {
        const dlm = kw.has("DLM") ? unquote(kw.get("DLM")!) : "/*";
        instream = { dlm, slashEnds: first === "*" };
      }
    }
    cur = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].slice(0, 72).replace(/\s+$/, "");
    if (instream) {
      if (line.startsWith(instream.dlm)) {
        instream = undefined;
        continue;
      }
      if (instream.slashEnds && line.startsWith("//")) {
        instream = undefined; // // termina dados DD *; a linha é uma instrução
      } else {
        continue;
      }
    }
    if (line.startsWith("//*") || !line.startsWith("//")) {
      continue; // comentário, /* ou dados sem DD
    }
    const body = line.slice(2);
    if (cur) {
      // continuação: os operandos recomeçam depois dos espaços
      const more = operandField(body.trimStart());
      cur.operands += more;
      if (!more.endsWith(",")) {
        finish();
      }
      continue;
    }
    if (!body.trim()) {
      continue; // // fim do job
    }
    const m = /^(\S*)\s+(\S+)\s*(.*)$/.exec(body);
    if (!m) {
      continue;
    }
    cur = { name: m[1].toUpperCase(), op: m[2].toUpperCase(), operands: operandField(m[3]), line: i };
    if (!cur.operands.endsWith(",")) {
      finish();
    }
  }
  finish();
  return out;
}

/** Data sets referidos num JCL, agrupados por step. */
export function parseJcl(text: string): JclInfo {
  const sym = new Map<string, string>();
  const info: JclInfo = { jobName: "", steps: [] };
  const jobGroup: JclStep = { name: "JOB", exec: "", line: 0, job: true, dds: [] };
  let step: JclStep | undefined;
  let lastDd = "";

  for (const st of statements(text)) {
    const { pos, kw } = keywords(st.operands);
    switch (st.op) {
      case "JOB":
        info.jobName = st.name;
        jobGroup.line = st.line;
        break;
      case "SET":
        for (const [k, v] of kw) {
          sym.set(k, unquote(resolveSymbols(v, sym)));
        }
        break;
      case "PROC":
        // valores por omissão de um procedimento instream
        for (const [k, v] of kw) {
          if (!sym.has(k)) {
            sym.set(k, unquote(resolveSymbols(v, sym)));
          }
        }
        break;
      case "JCLLIB": {
        const order = kw.get("ORDER");
        if (order) {
          const libs = splitTop(order.replace(/^\(|\)$/g, ""));
          for (const lib of libs) {
            const dsn = unquote(resolveSymbols(lib.trim(), sym)).toUpperCase();
            if (dsn) {
              jobGroup.dds.push(makeDd("JCLLIB", dsn, "SHR", st.line, jobGroup.dds.length > 0 && jobGroup.dds[jobGroup.dds.length - 1].ddName === "JCLLIB"));
            }
          }
        }
        break;
      }
      case "EXEC": {
        const pgm = kw.get("PGM");
        const proc = kw.get("PROC") ?? pos[0];
        step = {
          name: st.name || `(line ${st.line + 1})`,
          exec: pgm ? `PGM=${resolveSymbols(pgm, sym).toUpperCase()}` : proc ? resolveSymbols(proc, sym).toUpperCase() : "",
          line: st.line,
          job: false,
          dds: [],
        };
        info.steps.push(step);
        lastDd = "";
        break;
      }
      case "DD": {
        const concat = !st.name;
        const ddName = st.name || lastDd;
        if (st.name) {
          lastDd = st.name;
        }
        const raw = kw.get("DSN") ?? kw.get("DSNAME");
        const first = (pos[0] ?? "").toUpperCase();
        if (!raw || first === "DUMMY" || kw.has("SYSOUT")) {
          break;
        }
        const dsn = unquote(resolveSymbols(raw.trim(), sym)).toUpperCase();
        if (!dsn || dsn.startsWith("&&") || dsn.startsWith("*.") || dsn === "NULLFILE") {
          break; // temporário, referência a outro DD ou ficheiro nulo
        }
        const dispRaw = kw.get("DISP");
        let disp = "NEW";
        if (dispRaw) {
          const d = splitTop(dispRaw.replace(/^\(|\)$/g, ""))[0].trim().toUpperCase();
          disp = d || "NEW";
        }
        const dd = makeDd(ddName, dsn, disp, st.line, concat);
        if (step) {
          step.dds.push(dd);
        } else {
          jobGroup.dds.push(dd); // JOBLIB / JOBCAT antes do primeiro EXEC
        }
        break;
      }
    }
  }
  if (jobGroup.dds.length) {
    jobGroup.exec = [...new Set(jobGroup.dds.map((d) => d.ddName))].join(", ");
    info.steps.unshift(jobGroup);
  }
  return info;
}

function makeDd(ddName: string, dsn: string, disp: string, line: number, concat: boolean): JclDd {
  const m = /^([^()]+)(?:\(([^)]*)\))?$/.exec(dsn);
  const base = m ? m[1] : dsn;
  const paren = m?.[2];
  const dd: JclDd = { ddName, dsn, base, disp, line, concat, unresolved: dsn.includes("&") };
  if (paren) {
    if (/^[+-]?\d+$/.test(paren)) {
      dd.gdg = paren;
    } else {
      dd.member = paren;
    }
  }
  return dd;
}
