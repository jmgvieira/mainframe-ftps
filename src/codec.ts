/**
 * Codificação usada na ligação de dados FTP (lado PC).
 * O z/OS converte entre esta codificação e o código de página do mainframe (ex.: IBM-1147).
 *
 * Node não traz ISO-8859-15 (Latin-9, com €), por isso é feita aqui:
 * é igual a ISO-8859-1 exceto em 8 posições.
 */
export type TransferEncoding = "iso8859-15" | "latin1" | "utf8";

const L9_TO_UNI: Record<number, string> = {
  0xa4: "€", 0xa6: "Š", 0xa8: "š", 0xb4: "Ž", 0xb8: "ž", 0xbc: "Œ", 0xbd: "œ", 0xbe: "Ÿ",
};
const UNI_TO_L9: Record<string, number> = Object.fromEntries(
  Object.entries(L9_TO_UNI).map(([b, ch]) => [ch, Number(b)])
);
const L1_ONLY = new Set(Object.keys(L9_TO_UNI).map((b) => String.fromCharCode(Number(b))));

/** Nome da codificação tal como o z/OS a conhece no SITE SBDATACONN. */
export function zosName(enc: TransferEncoding): string {
  return enc === "iso8859-15" ? "ISO8859-15" : enc === "latin1" ? "ISO8859-1" : "UTF-8";
}

export function encode(text: string, enc: TransferEncoding): Buffer {
  if (enc === "utf8") {
    return Buffer.from(text, "utf8");
  }
  const out = Buffer.alloc(text.length);
  let i = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (enc === "iso8859-15" && ch in UNI_TO_L9) {
      out[i++] = UNI_TO_L9[ch];
    } else if (code <= 0xff && !(enc === "iso8859-15" && L1_ONLY.has(ch))) {
      out[i++] = code;
    } else {
      out[i++] = 0x3f; // '?'
    }
  }
  return out.subarray(0, i);
}

export function decode(buf: Buffer, enc: TransferEncoding): string {
  if (enc === "utf8") {
    return buf.toString("utf8");
  }
  if (enc === "latin1") {
    return buf.toString("latin1");
  }
  let s = "";
  for (const b of buf) {
    s += L9_TO_UNI[b] ?? String.fromCharCode(b);
  }
  return s;
}

/** Caracteres do texto que não existem na codificação. */
export function unsupported(text: string, enc: TransferEncoding): string[] {
  if (enc === "utf8") {
    return [];
  }
  const bad = new Set<string>();
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const ok =
      enc === "iso8859-15"
        ? ch in UNI_TO_L9 || (code <= 0xff && !L1_ONLY.has(ch))
        : code <= 0xff;
    if (!ok) {
      bad.add(ch);
    }
  }
  return [...bad];
}
