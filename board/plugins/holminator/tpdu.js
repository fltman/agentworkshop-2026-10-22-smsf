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
  const vp = decodeVp(b, i, vpf);
  i += VP_LEN[vpf];
  const udl = b[i++];
  if (udl === undefined) throw new Error('truncated SMS-SUBMIT');
  return {
    type: 'SMS-SUBMIT', mr, da: da.addr, daToa: da.toa, pid, dcs, vpf, ...vp,
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

// Two semi-octet decimal digits (low nibble first), or NaN when either nibble is not 0-9.
const semi = x => ((x & 0x0f) > 9 || (x >> 4) > 9 ? NaN : (x & 0x0f) * 10 + (x >> 4));
const toSemi = n => { const s = String(n).padStart(2, '0'); return ((+s[1]) << 4) | +s[0]; };

// TS 23.040 9.2.3.12.2, absolute TP-VP: TP-SCTS coding (YY MM DD hh mm ss TZ, TZ in quarter hours, sign in bit 3).
// Returns the expiry as epoch ms, or null when the digits are not a valid time.
function absoluteVpMs(b, i) {
  const [yy, mo, dd, hh, mi, ss] = [0, 1, 2, 3, 4, 5].map(k => semi(b[i + k]));
  const tzo = b[i + 6];
  const tzq = semi(tzo & 0xf7);
  if ([yy, mo, dd, hh, mi, ss, tzq].some(Number.isNaN) || mo < 1 || mo > 12 || dd < 1 || hh > 23 || mi > 59 || ss > 59) return null;
  const local = Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss);
  if (new Date(local).getUTCDate() !== dd) return null; // 31 February and the like
  return local - ((tzo & 0x08) ? -1 : 1) * tzq * 15 * 60000;
}

// TS 23.040 9.2.3.12.3, enhanced TP-VP (7 octets). Octet 1 is the functionality indicator: b7 extension, b6
// single-shot SM, b2..b0 format. Extension octets (none defined yet) follow while b7 is set; the VP value comes after.
// Reserved formats, a zero seconds value and set bits in extension octets are "TP-VP not supported" (TP-FCS C7).
const ENH_FORMATS = ['none', 'relative', 'seconds', 'hhmmss'];
function enhancedVp(b, i) {
  const fi = b[i];
  const out = { singleShot: !!(fi & 0x40), vpFormat: `enhanced-${ENH_FORMATS[fi & 7] || 'reserved'}`, validityMs: null };
  let k = i;
  while (b[k] & 0x80) {
    k++;
    if (k >= i + 6) return { ...out, vpError: 'enhanced TP-VP functionality indicator extends past the 7 octets' };
    if (b[k] & 0x7f) return { ...out, vpError: `reserved enhanced TP-VP extension octet 0x${b[k].toString(16)}` };
  }
  const v = k + 1;
  switch (fi & 7) {
    case 0: return out;
    case 1: return { ...out, validityMs: relativeVpMs(b[v]) };
    case 2: return b[v] ? { ...out, validityMs: b[v] * 1000 } : { ...out, vpError: 'enhanced TP-VP of 0 seconds is reserved' };
    case 3: {
      const [hh, mm, ss] = [semi(b[v]), semi(b[v + 1]), semi(b[v + 2])];
      if ([hh, mm, ss].some(Number.isNaN) || mm > 59 || ss > 59) return { ...out, vpError: 'enhanced TP-VP HH:MM:SS is not valid semi-octets' };
      return { ...out, validityMs: ((hh * 60 + mm) * 60 + ss) * 1000 };
    }
    default: return { ...out, vpError: `reserved enhanced TP-VP format ${fi & 7}` };
  }
}

// TP-VP by TP-VPF (9.2.3.3): validityMs is relative to SC receipt, validUntil an absolute ISO time; vpError means
// the SC must reject the SUBMIT with TP-FCS C7.
function decodeVp(b, i, vpf) {
  if (vpf === 0) return { vpFormat: 'none', validityMs: null };
  if (b.length < i + VP_LEN[vpf]) return { vpFormat: 'truncated', validityMs: null };
  if (vpf === 2) return { vpFormat: 'relative', validityMs: relativeVpMs(b[i]) };
  if (vpf === 1) return enhancedVp(b, i);
  const at = absoluteVpMs(b, i);
  return at === null ? { vpFormat: 'absolute', validityMs: null, vpError: 'absolute TP-VP is not a valid time' }
    : { vpFormat: 'absolute', validityMs: null, validUntil: new Date(at).toISOString() };
}

// vp: a number (relative octet), or { type: 'relative', value }, { type: 'absolute', time, tzMinutes },
// { type: 'enhanced', format: 'none'|'relative'|'seconds'|'hhmmss'|0..7, value, singleShot }, { type: 'raw', vpf, hex }.
function encodeVp(vp) {
  if (vp === null || vp === undefined) return { vpf: 0, bytes: [] };
  if (typeof vp === 'number') return { vpf: 2, bytes: [vp & 0xff] };
  const type = String(vp.type || '').toLowerCase();
  if (type === 'relative') return { vpf: 2, bytes: [Number(vp.value) & 0xff] };
  if (type === 'absolute') {
    const tz = Math.round(Number(vp.tzMinutes || 0) / 15);
    const t = new Date(vp.time);
    if (Number.isNaN(t.getTime()) || Math.abs(tz) > 79) throw new Error('absolute vp needs a valid time and |tzMinutes| <= 1185');
    const l = new Date(t.getTime() + tz * 15 * 60000);
    return { vpf: 3, bytes: [l.getUTCFullYear() % 100, l.getUTCMonth() + 1, l.getUTCDate(), l.getUTCHours(), l.getUTCMinutes(), l.getUTCSeconds()]
      .map(toSemi).concat(toSemi(Math.abs(tz)) | (tz < 0 ? 0x08 : 0)) };
  }
  if (type === 'enhanced') {
    const f = typeof vp.format === 'number' ? vp.format & 7 : ENH_FORMATS.indexOf(String(vp.format || 'none'));
    if (f < 0) throw new Error(`enhanced vp format must be one of ${ENH_FORMATS.join(', ')} or 0-7`);
    const bytes = [f | (vp.singleShot ? 0x40 : 0), 0, 0, 0, 0, 0, 0];
    if (f === 1 || f === 2) bytes[1] = Number(vp.value) & 0xff;
    if (f === 3) {
      const secs = typeof vp.value === 'string' ? vp.value.split(':').reduce((a, x) => a * 60 + Number(x), 0) : Number(vp.value);
      bytes.splice(1, 3, toSemi(Math.floor(secs / 3600) % 100), toSemi(Math.floor(secs / 60) % 60), toSemi(secs % 60));
    }
    return { vpf: 1, bytes };
  }
  if (type === 'raw') {
    const vpf = Number(vp.vpf) & 3, bytes = hexToBytes(vp.hex || '');
    if (bytes.length !== VP_LEN[vpf]) throw new Error(`raw vp for TP-VPF ${vpf} must be ${VP_LEN[vpf]} octets`);
    return { vpf, bytes };
  }
  throw new Error('vp type must be relative, absolute, enhanced or raw');
}

function encodeSubmit({ mr = 0, to, text, srr = false, rd = false, vp = null }) {
  const u = encUd(text);
  const v = encodeVp(vp);
  const fo = 0x01 | (srr ? 0x20 : 0) | (rd ? 0x04 : 0) | (v.vpf << 3);
  return [fo, mr & 0xff, ...encTpAddr(to), 0x00, u.dcs, ...v.bytes, u.udl, ...u.ud];
}

// Semi-octet TP-SCTS / TP-DT back to an ISO time (TZ in quarter hours, sign in bit 3 of the 7th octet).
function decScts(b, i) {
  const d = k => (b[i + k] & 0x0f) * 10 + (b[i + k] >> 4);
  const tzq = (b[i + 6] & 0x07) * 10 + (b[i + 6] >> 4);
  const tzMin = ((b[i + 6] & 0x08) ? -1 : 1) * tzq * 15;
  const utc = Date.UTC(2000 + d(0), d(1) - 1, d(2), d(3), d(4), d(5)) - tzMin * 60000;
  return new Date(utc).toISOString();
}

// SMS-DELIVER, TS 23.040 9.2.2.1. TP-MMS is inverted: bit set = no more messages waiting in the SC.
function encodeDeliver({ from, text, sri = false, date, moreToSend = false, rp = false, pid = 0 }) {
  const u = encUd(text);
  const fo = (moreToSend ? 0 : 0x04) | (sri ? 0x20 : 0) | (rp ? 0x80 : 0);
  return [fo, ...encTpAddr(from), pid & 0xff, u.dcs, ...scts(date), u.udl, ...u.ud];
}

function decodeDeliver(b) {
  const fo = b[0];
  if ((fo & 3) !== 0) throw new Error('not an SMS-DELIVER');
  const oa = decTpAddr(b, 1);
  let i = oa.next;
  const pid = b[i++], dcs = b[i++];
  const sctsIso = decScts(b, i);
  i += 7;
  const udl = b[i++];
  if (udl === undefined) throw new Error('truncated SMS-DELIVER');
  return {
    type: 'SMS-DELIVER', oa: oa.addr, pid, dcs, scts: sctsIso,
    moreToSend: !(fo & 0x04), sri: !!(fo & 0x20), rp: !!(fo & 0x80),
    text: decUd(b, i, dcs, udl, fo & 0x40),
  };
}

// SMS-STATUS-REPORT, TS 23.040 9.2.2.3: MTI=10, TP-SRQ=0 (result of an SMS-SUBMIT), MR and RA of the original
// SUBMIT, its SC timestamp, the discharge time and TP-ST.
function encodeStatusReport({ mr, ra, sctsDate, dtDate, st, moreToSend = false }) {
  return [0x02 | (moreToSend ? 0 : 0x04), mr & 0xff, ...encTpAddr(ra), ...scts(sctsDate), ...scts(dtDate), st & 0xff];
}

function decodeStatusReport(b) {
  const fo = b[0];
  if ((fo & 3) !== 2) throw new Error('not an SMS-STATUS-REPORT');
  const ra = decTpAddr(b, 2);
  let i = ra.next;
  if (b.length < i + 15) throw new Error('truncated SMS-STATUS-REPORT');
  const out = { type: 'SMS-STATUS-REPORT', mr: b[1], ra: ra.addr, srq: !!(fo & 0x20), moreToSend: !(fo & 0x04) };
  out.scts = decScts(b, i); i += 7;
  out.dt = decScts(b, i); i += 7;
  out.st = b[i];
  return out;
}

// TP-ST values the SC uses (TS 23.040 9.2.3.15).
const ST = {
  RECEIVED_BY_SME: 0x00,
  NO_RESPONSE_FROM_SME_TRYING: 0x22,
  REMOTE_PROCEDURE_ERROR: 0x40,
  INCOMPATIBLE_DESTINATION: 0x41,
  NOT_OBTAINABLE: 0x43,
  NO_RESPONSE_FROM_SME_STOPPED: 0x62,
  VALIDITY_PERIOD_EXPIRED: 0x46,
  ERROR_IN_SME_STOPPED: 0x65,
  SERVICE_REJECTED_STOPPED: 0x63,
};

// RP-ERROR (TS 24.011 7.3.4): MTI, ref, cause length, cause. Returns the RP-Cause or null for anything else.
function rpErrorCause(hex) {
  try {
    const b = hexToBytes(hex);
    if ((b[0] & 7) !== 4 && (b[0] & 7) !== 5) return null;
    return b[2] >= 1 ? (b[3] & 0x7f) : null;
  } catch { return null; }
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

// RP-Cause values, TS 24.011 8.2.5.4 table 8.4.
const RP_CAUSE = {
  1: 'Unassigned (unallocated) number', 8: 'Operator determined barring', 10: 'Call barred', 11: 'Reserved',
  21: 'Short message transfer rejected', 22: 'Memory capacity exceeded', 27: 'Destination out of order',
  28: 'Unidentified subscriber', 29: 'Facility rejected', 30: 'Unknown subscriber', 38: 'Network out of order',
  41: 'Temporary failure', 42: 'Congestion', 47: 'Resources unavailable, unspecified',
  50: 'Requested facility not subscribed', 69: 'Requested facility not implemented',
  81: 'Invalid short message transfer reference value', 95: 'Semantically incorrect message',
  96: 'Invalid mandatory information', 97: 'Message type non-existent or not implemented',
  98: 'Message not compatible with short message protocol state', 99: 'Information element non-existent or not implemented',
  111: 'Protocol error, unspecified', 127: 'Interworking, unspecified',
};
const rpCauseName = c => RP_CAUSE[c] || 'Unknown RP-Cause';

// RP-ACK (TS 24.011 7.3.3) and RP-ERROR (7.3.4): MTI, MR, [RP-Cause LV], optional RP-User-Data (IEI 0x41, TLV).
function decodeRpAckError(b) {
  const mti = b[0] & 7;
  if (mti < 2 || mti > 5) throw new Error('not an RP-ACK or RP-ERROR');
  if (b.length < 2) throw new Error('truncated RP message');
  const out = { mti, rpMessage: RP_MTI[mti], rpRef: b[1] };
  let i = 2;
  if (mti >= 4) {
    const len = b[i];
    if (!len || i + 1 + len > b.length) throw new Error('RP-ERROR without a valid RP-Cause');
    out.rpCause = b[i + 1] & 0x7f;
    out.rpCauseName = rpCauseName(out.rpCause);
    if (len >= 2) out.rpDiagnostic = b[i + 2];
    i += 1 + len;
  }
  out.tpdu = null;
  if (i < b.length) {
    if (b[i] !== 0x41) throw new Error(`unexpected RP IE 0x${b[i].toString(16)}`);
    const len = b[i + 1];
    const t = b.slice(i + 2, i + 2 + len);
    if (!len || t.length !== len) throw new Error('RP-User-Data overruns message');
    out.tpdu = t;
  }
  return out;
}

// Number of UD octets for a given DCS and UDL (7-bit counts septets).
const udOctets = (dcs, udl) => {
  const alphabet = (dcs & 0xc0) === 0 ? (dcs >> 2) & 3 : (dcs & 0xf0) === 0xf0 ? (dcs >> 2) & 1 : 0;
  return alphabet === 0 ? Math.ceil((udl * 7) / 8) : udl;
};
const TP_PI = (out, pi) => { out.pi = pi; out.pidPresent = !!(pi & 1); out.dcsPresent = !!(pi & 2); out.udlPresent = !!(pi & 4); };
// Optional PID/DCS/UDL+UD of a report, driven by TP-PI.
function decReportTail(b, i, fo, out) {
  const pi = out.pi;
  if (pi & 1) out.pid = b[i++];
  const dcs = pi & 2 ? b[i++] : 0;
  if (pi & 2) out.dcs = dcs;
  if (pi & 4) {
    const udl = b[i++];
    if (udl === undefined) throw new Error(`truncated ${out.type}`);
    out.udl = udl;
    out.text = decUd(b, i, dcs, udl, fo & 0x40);
    i += udOctets(dcs, udl);
  }
  if (i > b.length) throw new Error(`truncated ${out.type}`);
  Object.defineProperty(out, '_end', { value: i });
  return out;
}
// The RP-ERROR variant has TP-FCS (always >= 0x80) before TP-PI; TP-PI bit 7 (extension) is 0 in practice.
const guessError = b => !!(b[1] & 0x80);

// SMS-SUBMIT-REPORT, TS 23.040 9.2.2.2a: FO (MTI 01, UDHI), [TP-FCS], TP-PI, TP-SCTS, [PID], [DCS], [UDL UD].
function decodeSubmitReport(b, { error } = {}) {
  const fo = b[0];
  if ((fo & 3) !== 1) throw new Error('not an SMS-SUBMIT-REPORT');
  const isErr = error === undefined ? guessError(b) : !!error;
  const out = { type: 'SMS-SUBMIT-REPORT', variant: isErr ? 'RP-ERROR' : 'RP-ACK', udhi: !!(fo & 0x40) };
  let i = 1;
  if (isErr) { out.fcs = b[i++]; out.fcsName = fcsName(out.fcs); }
  if (b.length < i + 8) throw new Error('truncated SMS-SUBMIT-REPORT');
  TP_PI(out, b[i++]);
  out.scts = decScts(b, i); i += 7;
  return decReportTail(b, i, fo, out);
}

// SMS-DELIVER-REPORT, TS 23.040 9.2.2.1a: FO (MTI 00, UDHI), [TP-FCS], TP-PI, [PID], [DCS], [UDL UD].
function decodeDeliverReport(b, { error } = {}) {
  const fo = b[0];
  if ((fo & 3) !== 0) throw new Error('not an SMS-DELIVER-REPORT');
  const isErr = error === undefined ? guessError(b) : !!error;
  const out = { type: 'SMS-DELIVER-REPORT', variant: isErr ? 'RP-ERROR' : 'RP-ACK', udhi: !!(fo & 0x40) };
  let i = 1;
  if (isErr) { out.fcs = b[i++]; out.fcsName = fcsName(out.fcs); }
  if (b.length < i + 1) throw new Error('truncated SMS-DELIVER-REPORT');
  TP_PI(out, b[i++]);
  return decReportTail(b, i, fo, out);
}
const fcsName = v => Object.keys(FCS).find(k => FCS[k] === v) || (v === 0xd0 ? 'MEMORY_CAPACITY_EXCEEDED' : 'UNKNOWN');

// Does a decoded SUBMIT/DELIVER end exactly where the bytes do? Used to break MTI ambiguity without a hint.
function fitsExactly(b, d) {
  if (d._end !== undefined) return d._end === b.length;
  if (d.type === 'SMS-STATUS-REPORT') return true;
  const addr = decTpAddr(b, d.type === 'SMS-SUBMIT' ? 2 : 1);
  let i = addr.next + 2 + (d.type === 'SMS-SUBMIT' ? VP_LEN[d.vpf] : 7);
  const udl = b[i++];
  return i + udOctets(d.dcs, udl) === b.length;
}

const normKind = k => String(k || '').toLowerCase().replace(/^sms[-_ ]?/, '').replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
const normDir = d => {
  const s = String(d || '').toLowerCase().replace(/\s+/g, '');
  if (/^(mo|ms->(sc|n|network)|ue->(sc|n|network)|uplink|ms-to-sc)$/.test(s)) return 'MO';
  if (/^(mt|(sc|n|network)->(ms|ue)|downlink|sc-to-ms)$/.test(s)) return 'MT';
  return null;
};

// Best-effort decoder for the test endpoint: RP-DATA/RP-ACK/RP-ERROR or a bare TPDU (SUBMIT, DELIVER,
// STATUS-REPORT, SUBMIT-REPORT, DELIVER-REPORT). The TP-MTI is ambiguous by direction, so the RP container
// decides; for a bare TPDU an optional hint does: kind ('submit-report', 'deliver-report', 'submit', 'deliver',
// 'status-report') or direction ('MO' = MS->SC, 'MT' = SC->MS, tried first). Without a hint the first exact fit wins.
function decodeAny(hex, { kind, direction } = {}) {
  const b = hexToBytes(hex);
  if (!b.length) throw new Error('empty payload');
  const rpMti = b[0] & 7;
  let t = b, rpInfo = null, error, dir = normDir(direction);
  if (rpMti <= 1) {
    const rp = unwrapRp(b);
    if (rp) {
      t = rp.tpdu; dir = rpMti === 0 ? 'MO' : 'MT';
      rpInfo = { rpMessage: RP_MTI[rp.mti], rpRef: rp.ref, rpOa: rp.rpOa || null, rpDa: rp.rpDa || null };
    }
  } else if (rpMti <= 5 && !normKind(kind)) {
    // A bare TPDU can start with these low bits too (e.g. SMS-DELIVER FO 0x04): only a clean RP parse counts.
    let r = null;
    try { r = decodeRpAckError(b); } catch { /* not RP, try as a TPDU */ }
    if (r && r.tpdu) {
      const f = rpMti % 2 === 0 ? decodeDeliverReport : decodeSubmitReport;
      try { if (f(r.tpdu, { error: rpMti >= 4 })._end !== r.tpdu.length) r = null; } catch { r = null; }
    }
    if (r) {
      // RP-ACK/RP-ERROR MS->N answer an MT RP-DATA (DELIVER-REPORT); N->MS answer an MO one (SUBMIT-REPORT).
      rpInfo = { rpMessage: r.rpMessage, rpRef: r.rpRef };
      if (r.rpCause !== undefined) Object.assign(rpInfo, { rpCause: r.rpCause, rpCauseName: r.rpCauseName });
      if (r.rpDiagnostic !== undefined) rpInfo.rpDiagnostic = r.rpDiagnostic;
      if (!r.tpdu) return { rp: rpInfo, tpdu: null };
      t = r.tpdu; error = rpMti >= 4;
      const f = rpMti % 2 === 0 ? decodeDeliverReport : decodeSubmitReport;
      return { rp: rpInfo, tpdu: { hex: bytesToHex(t), ...f(t, { error }) } };
    }
  }
  const mti = t[0] & 3;
  const k = normKind(kind);
  const opt = { error: /error/.test(k) ? true : /ack/.test(k) ? false : undefined };
  const byKind = { 'submit-report': decodeSubmitReport, 'deliver-report': decodeDeliverReport, submit: decodeSubmit, deliver: decodeDeliver, 'status-report': decodeStatusReport };
  const kk = Object.keys(byKind).find(x => k === x || k.startsWith(x + '-'));
  let attempts;
  if (kk) attempts = [byKind[kk]];
  else if (mti === 2) attempts = [decodeStatusReport];
  else if (mti === 1) attempts = dir === 'MT' ? [decodeSubmitReport, decodeSubmit] : [decodeSubmit, decodeSubmitReport];
  else attempts = dir === 'MO' ? [decodeDeliverReport, decodeDeliver] : [decodeDeliver, decodeDeliverReport];
  let lastErr, loose = null;
  for (const f of attempts) {
    try {
      const d = f(t, opt);
      if (attempts.length === 1 || fitsExactly(t, d)) return { rp: rpInfo, tpdu: { hex: bytesToHex(t), ...d } };
      loose = loose || d;
    } catch (e) { lastErr = e; }
  }
  if (loose) return { rp: rpInfo, tpdu: { hex: bytesToHex(t), ...loose } };
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
  encodeStatusReport, decodeStatusReport, ST, rpErrorCause,
  unwrapRp, wrapRpDataToMs, wrapRpDataToNetwork, decodeMo, decodeAny,
  decodeRpAckError, decodeSubmitReport, decodeDeliverReport, RP_CAUSE,
};
