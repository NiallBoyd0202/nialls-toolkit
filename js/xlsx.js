// Minimal dependency-free .xlsx reader (first worksheet -> array of rows).
// Uses the browser's built-in DecompressionStream to inflate the zip entries.
import { parseCSV } from './util.js';

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readZipEntries(buf) {
  const dv = new DataView(buf);
  // Find End Of Central Directory record.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx (zip) file');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = {};
  const dec = new TextDecoder();
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    entries[name] = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, dv };
}

async function readEntry(buf, zip, name) {
  const e = zip.entries[name];
  if (!e) return null;
  const dv = zip.dv;
  const nameLen = dv.getUint16(e.localOff + 26, true);
  const extraLen = dv.getUint16(e.localOff + 28, true);
  const start = e.localOff + 30 + nameLen + extraLen;
  const data = new Uint8Array(buf, start, e.compSize);
  const out = e.method === 0 ? data : await inflateRaw(data);
  return new TextDecoder().decode(out);
}

function colIndex(ref) {
  const letters = ref.replace(/[0-9]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(arrayBuffer) {
  const zip = readZipEntries(arrayBuffer);
  const parser = new DOMParser();

  // Shared strings
  const shared = [];
  const ssXml = await readEntry(arrayBuffer, zip, 'xl/sharedStrings.xml');
  if (ssXml) {
    const doc = parser.parseFromString(ssXml, 'application/xml');
    for (const si of doc.getElementsByTagName('si')) {
      let t = '';
      for (const tn of si.getElementsByTagName('t')) t += tn.textContent;
      shared.push(t);
    }
  }

  // Locate first sheet via workbook rels (fallback to sheet1.xml)
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const wb = parser.parseFromString(await readEntry(arrayBuffer, zip, 'xl/workbook.xml'), 'application/xml');
    const firstSheet = wb.getElementsByTagName('sheet')[0];
    const rid = firstSheet && (firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rels = parser.parseFromString(await readEntry(arrayBuffer, zip, 'xl/_rels/workbook.xml.rels'), 'application/xml');
    for (const r of rels.getElementsByTagName('Relationship')) {
      if (r.getAttribute('Id') === rid) {
        const target = r.getAttribute('Target').replace(/^\/?(xl\/)?/, '');
        sheetPath = `xl/${target}`;
      }
    }
  } catch { /* use fallback */ }

  const sheetXml = await readEntry(arrayBuffer, zip, sheetPath) || await readEntry(arrayBuffer, zip, 'xl/worksheets/sheet1.xml');
  if (!sheetXml) throw new Error('Could not find a worksheet in this file');
  const doc = parser.parseFromString(sheetXml, 'application/xml');
  const rows = [];
  for (const r of doc.getElementsByTagName('row')) {
    const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const ref = c.getAttribute('r');
      const idx = ref ? colIndex(ref) : row.length;
      const type = c.getAttribute('t');
      const vEl = c.getElementsByTagName('v')[0];
      let val = '';
      if (type === 's') val = shared[parseInt(vEl?.textContent || '0', 10)] ?? '';
      else if (type === 'inlineStr') {
        for (const tn of c.getElementsByTagName('t')) val += tn.textContent;
      } else if (vEl) {
        val = vEl.textContent;
        // keep long numeric codes (EANs) as plain digits rather than 5.01E+12
        if (/^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(val) && /E/i.test(val)) {
          const n = Number(val);
          if (Number.isFinite(n) && Math.abs(n) >= 1e6) val = BigInt(Math.round(n)).toString();
        }
      }
      while (row.length < idx) row.push('');
      row[idx] = val;
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export async function readTabularFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return readXlsx(await file.arrayBuffer());
  if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported — open it in Excel and "Save As" .xlsx or .csv');
  return parseCSV(await file.text());
}
