// TS 23.040 TPDU and TS 24.011 RP codec for the SMSC. Pure functions, no I/O.

const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

const hexToBytes = h => {
  const s = String(h || '').replace(/\s+/g, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('not hex');
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
};
const bytesToHex = b => b.map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();

const digitsOf = a => String(a || '').replace(/^msisdn-/, '').replace(/^\+/, '').replace(/\D/g, '');

// Semi-octet BCD, F-padded.
function encBcd(digits) {
  const out = [];
  for (let i = 0; i < digits.length; i += 2) {
    const lo = +digits[i];
    const hi = i + 1 < digits.length ? +digits[i + 1] : 0xf;
    out.push((hi << 4) | lo);
  }
  return out;
}
function decBcd(bytes, n) {
  let s = '';
  for (const b of bytes) s += (b & 0xf).toString(16) + ((b >> 4) & 0xf).toString(16);
  return s.slice(0, n).replace(/f/gi, '');
}

// TP address: length in digits, TON/NPI, BCD.
function encTpAddr(addr) {
  const d = digitsOf(addr);
  return [d.length, 0x91, ...encBcd(d)];
}
function decTpAddr(b, i) {
  const n = b[i];
  const toa = b[i + 1];
  const len = Math.ceil(n / 2);
  if (i + 2 + len > b.length) throw new Error('address overruns TPDU');
  const raw = b.slice(i + 2, i + 2 + len);
  const addr = ((toa >> 4) & 7) === 5 ? unpack7(raw, Math.floor((n * 4) / 7)) : decBcd(raw, n);
  return { addr, toa, next: i + 2 + len };
}

// RP address (TS 24.011 8.2.5.1/2): length in octets incl. TON/NPI.
function encRpAddr(addr) {
  const d = digitsOf(addr);
  if (!d) return [0];
  const bcd = encBcd(d);
  return [bcd.length + 1, 0x91, ...bcd];
}
function decRpAddr(b, i) {
  const n = b[i];
  if (!n) return { addr: '', next: i + 1 };
  return { addr: decBcd(b.slice(i + 2, i + 1 + n), (n - 1) * 2), next: i + 1 + n };
}

function pack7(text) {
  const septets = [];
  for (const ch of text) {
    const k = GSM7.indexOf(ch);
    septets.push(k < 0 ? 0x3f : k);
  }
  const out = [];
  let acc = 0, bits = 0;
  for (const s of septets) {
    acc |= s << bits; bits += 7;
    while (bits >= 8) { out.push(acc & 0xff); acc >>= 8; bits -= 8; }
  }
  if (bits > 0) out.push(acc & 0xff);
  return { bytes: out, septets: septets.length };
}
function unpack7(bytes, count, skipBits = 0) {
  let s = '';
  for (let k = 0; k < count; k++) {
    const bit = skipBits + k * 7;
    const i = bit >> 3, sh = bit & 7;
    const v = ((bytes[i] >> sh) | ((bytes[i + 1] || 0) << (8 - sh))) & 0x7f;
    s += GSM7[v] || '?';
  }
  return s;
}

const isGsm7 = t => [...t].every(ch => GSM7.indexOf(ch) >= 0 && ch !== '\x1b');

function encUd(text) {
  if (isGsm7(text)) { const p = pack7(text); return { dcs: 0x00, udl: p.septets, ud: p.bytes }; }
  const ud = [];
  for (let k = 0; k < text.length; k++) { const c = text.charCodeAt(k); ud.push(c >> 8, c & 0xff); }
  return { dcs: 0x08, udl: ud.length, ud };
}
function decUd(b, i, dcs, udl, udhi) {
  const alphabet = (dcs & 0xc0) === 0 ? (dcs >> 2) & 3 : (dcs & 0xf0) === 0xf0 ? (dcs >> 2) & 1 : 0;
  const ud = b.slice(i);
  const udhLen = udhi ? ud[0] + 1 : 0;
  if (alphabet === 0) {
    const skipSeptets = udhi ? Math.ceil((udhLen * 8) / 7) : 0;
    return unpack7(ud, udl - skipSeptets, skipSeptets * 7);
  }
  const body = ud.slice(udhLen, udl);
  if (alphabet === 2) {
    let s = '';
    for (let k = 0; k + 1 < body.length; k += 2) s += String.fromCharCode((body[k] << 8) | body[k + 1]);
    return s;
  }
  return bytesToHex(body);
}

const VP_LEN = [0, 7, 1, 7]; // by TP-VPF: none, enhanced, relative, absolute

function scts(date = new Date()) {
  const sw = n => { const s = String(n).padStart(2, '0'); return ((+s[1]) << 4) | +s[0]; };
  return [sw(date.getUTCFullYear() % 100), sw(date.getUTCMonth() + 1), sw(date.getUTCDate()),
    sw(date.getUTCHours()), sw(date.getUTCMinutes()), sw(date.getUTCSeconds()), 0x00];
}

function decodeSubmit(b) {
  const fo = b[0];
  if ((fo & 3) !== 1) throw new Error('not an SMS-SUBMIT');
  const mr = b[1];
  const da = decTpAddr(b, 2);
  let i = da.next;
  const pid = b[i++], dcs = b[i++];
  const vpf = (fo >> 3) & 3;
  const validityMs = vpf === 2 ? relativeVpMs(b[i]) : null;
  i += VP_LEN[vpf];
  const udl = b[i++];
  if (udl === undefined) throw new Error('truncated SMS-SUBMIT');
  return {
    type: 'SMS-SUBMIT', mr, da: da.addr, daToa: da.toa, pid, dcs, vpf, validityMs,
    srr: !!(fo & 0x20), udhi: !!(fo & 0x40), rd: !!(fo & 0x04), rp: !!(fo & 0x80),
    text: decUd(b, i, dcs, udl, fo & 0x40),
  };
}

// TS 23.040 9.2.3.12.1, relative TP-VP.
function relativeVpMs(v) {
  const MIN = 60000;
  if (v <= 143) return (v + 1) * 5 * MIN;
  if (v <= 167) return 12 * 60 * MIN + (v - 143) * 30 * MIN;
  if (v <= 196) return (v - 166) * 24 * 60 * MIN;
  return (v - 192) * 7 * 24 * 60 * MIN;
}

function encodeSubmit({ mr = 0, to, text, srr = false, rd = false, vp = null }) {
  const u = encUd(text);
  const fo = 0x01 | (srr ? 0x20 : 0) | (rd ? 0x04 : 0) | (vp === null ? 0 : 0x10);
  return [fo, mr & 0xff, ...encTpAddr(to), 0x00, u.dcs, ...(vp === null ? [] : [vp & 0xff]), u.udl, ...u.ud];
}

// MTI=00, TP-MMS=1 (no more messages), TP-SRI if a status report is wanted.
function encodeDeliver({ from, text, sri = false, date }) {
  const u = encUd(text);
  return [0x04 | (sri ? 0x20 : 0), ...encTpAddr(from), 0x00, u.dcs, ...scts(date), u.udl, ...u.ud];
}

function decodeDeliver(b) {
  const fo = b[0];
  if ((fo & 3) !== 0) throw new Error('not an SMS-DELIVER');
  const oa = decTpAddr(b, 1);
  let i = oa.next;
  const pid = b[i++], dcs = b[i++];
  i += 7;
  const udl = b[i++];
  return { type: 'SMS-DELIVER', oa: oa.addr, pid, dcs, text: decUd(b, i, dcs, udl, fo & 0x40) };
}

// SMS-SUBMIT-REPORT for RP-ACK: MTI=01, TP-PI=0, TP-SCTS.
const encodeSubmitReportAck = date => [0x01, 0x00, ...scts(date)];
// SMS-SUBMIT-REPORT for RP-ERROR: MTI=01, TP-FCS, TP-PI=0, TP-SCTS.
const encodeSubmitReportError = (fcs, date) => [0x01, fcs & 0xff, 0x00, ...scts(date)];

// TP-FCS values (TS 23.040 9.2.3.22) the SC uses towards the originating UE.
const FCS = {
  TELEMATIC_INTERWORKING_NOT_SUPPORTED: 0x80,
  CANNOT_REPLACE_SM: 0x81,
  UNSPECIFIED_TP_PID_ERROR: 0x8f,
  DATA_CODING_SCHEME_NOT_SUPPORTED: 0x90,
  COMMAND_CANNOT_BE_ACTIONED: 0xa0,
  SC_BUSY: 0xc0,
  NO_SC_SUBSCRIPTION: 0xc1,
  SC_SYSTEM_FAILURE: 0xc2,
  INVALID_SME_ADDRESS: 0xc3,
  DESTINATION_SME_BARRED: 0xc4,
  SM_REJECTED_DUPLICATE_SM: 0xc5,
  TP_VPF_NOT_SUPPORTED: 0xc6,
  TP_VP_NOT_SUPPORTED: 0xc7,
  UNSPECIFIED: 0xff,
};

// TS 24.011: RP-DATA MS->N has MTI 0, RP-DATA N->MS has MTI 1.
function unwrapRp(b) {
  const mti = b[0] & 7;
  if (mti !== 0 && mti !== 1) return null;
  const oa = decRpAddr(b, 2);
  const da = decRpAddr(b, oa.next);
  const len = b[da.next];
  const tpdu = b.slice(da.next + 1, da.next + 1 + len);
  if (!len || tpdu.length !== len) return null;
  return { mti, ref: b[1], rpOa: oa.addr, rpDa: da.addr, tpdu };
}
function wrapRpDataToMs({ ref = 0, scAddress, tpdu }) {
  return [0x01, ref & 0xff, ...encRpAddr(scAddress), 0x00, tpdu.length, ...tpdu];
}
// RP-DATA MS->network (TS 24.011 7.3.1.2): empty RP-OA, RP-DA = SC address.
function wrapRpDataToNetwork({ ref = 0, scAddress, tpdu }) {
  return [0x00, ref & 0xff, 0x00, ...encRpAddr(scAddress), tpdu.length, ...tpdu];
}
const RP_MTI = ['RP-DATA (MS->N)', 'RP-DATA (N->MS)', 'RP-ACK (MS->N)', 'RP-ACK (N->MS)', 'RP-ERROR (MS->N)', 'RP-ERROR (N->MS)', 'RP-SMMA (MS->N)'];

// Best-effort decoder for the test endpoint: any RP-DATA, SMS-SUBMIT or SMS-DELIVER we know.
function decodeAny(hex) {
  const b = hexToBytes(hex);
  if (!b.length) throw new Error('empty payload');
  const rp = (b[0] & 7) <= 1 ? unwrapRp(b) : null;
  const t = rp ? rp.tpdu : b;
  const rpInfo = rp ? { rpMessage: RP_MTI[rp.mti], rpRef: rp.ref, rpOa: rp.rpOa || null, rpDa: rp.rpDa || null } : null;
  const attempts = (t[0] & 3) === 1 ? [decodeSubmit, decodeDeliver] : [decodeDeliver, decodeSubmit];
  let lastErr;
  for (const f of attempts) {
    try { return { rp: rpInfo, tpdu: { hex: bytesToHex(t), ...f(t) } }; } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('not a TPDU we know');
}

// The MO payload may be the bare SMS-SUBMIT (agreed) or a full RP-DATA (accepted).
function decodeMo(hex) {
  const b = hexToBytes(hex);
  if (!b.length) throw new Error('empty payload');
  if ((b[0] & 3) === 1) {
    try { return { rp: null, tpdu: b, submit: decodeSubmit(b) }; } catch { /* try RP-DATA */ }
  }
  const rp = unwrapRp(b);
  if (!rp) throw new Error('neither SMS-SUBMIT nor RP-DATA');
  return { rp, tpdu: rp.tpdu, submit: decodeSubmit(rp.tpdu) };
}

module.exports = {
  hexToBytes, bytesToHex, digitsOf,
  decodeSubmit, encodeSubmit, encodeDeliver, decodeDeliver, encodeSubmitReportAck, encodeSubmitReportError, FCS,
  unwrapRp, wrapRpDataToMs, wrapRpDataToNetwork, decodeMo, decodeAny,
};
