// SMS codec for the simulated UE: TS 24.011 RP layer around TS 23.040 TPDUs, GSM 7-bit default alphabet.
// Only what the UE needs: build RP-DATA(SMS-SUBMIT) and RP-ACK/RP-ERROR, parse RP-DATA(SMS-DELIVER or SMS-STATUS-REPORT).

const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

// RP message type indicators (TS 24.011 8.2.2), MS to network and network to MS.
const RP = { DATA_MS: 0, DATA_N: 1, ACK_MS: 2, ACK_N: 3, ERROR_MS: 4, ERROR_N: 5 };

const hex = bytes => Buffer.from(bytes).toString('hex').toUpperCase();

function bcd(digits) {
  const d = String(digits).replace(/\D/g, '');
  const out = [];
  for (let i = 0; i < d.length; i += 2) {
    const lo = Number(d[i]);
    const hi = i + 1 < d.length ? Number(d[i + 1]) : 0xf;
    out.push((hi << 4) | lo);
  }
  return out;
}

function unbcd(bytes) {
  let s = '';
  for (const b of bytes) {
    s += (b & 0xf).toString(16);
    if ((b >> 4) !== 0xf) s += (b >> 4).toString(16);
  }
  return s;
}

function pack7(text) {
  const septets = [...text].map(c => { const i = GSM7.indexOf(c); return i < 0 ? 0x3f : i; });
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const s of septets) {
    acc |= s << bits;
    bits += 7;
    while (bits >= 8) { out.push(acc & 0xff); acc >>= 8; bits -= 8; }
  }
  if (bits > 0) out.push(acc & 0xff);
  return { septets: septets.length, bytes: out };
}

function unpack7(bytes, count) {
  let s = '';
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (s.length < count) {
    if (bits < 7) { acc |= (bytes[i++] || 0) << bits; bits += 8; }
    s += GSM7[acc & 0x7f] || '?';
    acc >>= 7;
    bits -= 7;
  }
  return s;
}

// RP-DATA (MS to network) carrying SMS-SUBMIT. scAddress is the RP-DA (the SMSC), to is the TP-DA.
// srr sets TP-SRR (0x20): ask the SC for an SMS-STATUS-REPORT (TS 23.040 9.2.3.5).
function moSubmit({ rpMr, tpMr, scAddress, to, text, srr = false }) {
  const da = String(to).replace(/\D/g, '');
  const ud = pack7(text);
  const tpdu = [srr ? 0x21 : 0x01, tpMr & 0xff, da.length, 0x91, ...bcd(da), 0x00, 0x00, ud.septets, ...ud.bytes];
  const sc = bcd(scAddress);
  return hex([RP.DATA_MS, rpMr & 0xff, 0x00, sc.length + 1, 0x91, ...sc, tpdu.length, ...tpdu]);
}

// RP-ACK (MS to network) with an SMS-DELIVER-REPORT in RP-User data (IEI 0x41).
const rpAck = rpMr => hex([RP.ACK_MS, rpMr & 0xff, 0x41, 0x02, 0x00, 0x00]);

// RP-ERROR (MS to network). Cause 22 = memory capacity exceeded (TS 24.011 8.2.5.4).
const rpError = (rpMr, cause = 22) => hex([RP.ERROR_MS, rpMr & 0xff, 0x01, cause & 0x7f]);

// Parse RP-DATA (network to MS) carrying SMS-DELIVER or SMS-STATUS-REPORT. Throws on anything else.
function parseMt(hexStr) {
  const b = [...Buffer.from(String(hexStr), 'hex')];
  if (b.length < 4) throw new Error('RP message too short');
  const mti = b[0] & 0x07;
  if (mti !== RP.DATA_N) throw new Error(`expected RP-DATA network to MS (MTI 1), got MTI ${mti}`);
  const rpMr = b[1];
  let p = 2;
  const oaLen = b[p++];
  const scAddress = oaLen > 1 ? unbcd(b.slice(p + 1, p + oaLen)) : '';
  p += oaLen;
  p += 1 + b[p]; // RP-DA, empty in this direction
  const udLen = b[p++];
  const t = b.slice(p, p + udLen);
  if (t.length >= 2 && (t[0] & 0x03) === 0x02) return { rpMr, scAddress, ...statusReport(t) };
  if (t.length < 2 || (t[0] & 0x03) !== 0x00) throw new Error('RP-UD is not an SMS-DELIVER or SMS-STATUS-REPORT');
  let q = 1;
  const oaDigits = t[q++];
  q += 1; // type of address
  const from = unbcd(t.slice(q, q + Math.ceil(oaDigits / 2))).slice(0, oaDigits);
  q += Math.ceil(oaDigits / 2);
  q += 1; // TP-PID
  const dcs = t[q++];
  q += 7; // TP-SCTS
  const udl = t[q++];
  const text = (dcs & 0x0c) === 0 ? unpack7(t.slice(q), udl) : null;
  return { rpMr, scAddress, kind: 'deliver', from, text };
}

// SMS-STATUS-REPORT TPDU (TS 23.040 9.2.2.3): first octet, TP-MR, TP-RA, TP-SCTS, TP-DT, TP-ST.
// TP-ST 0x00-0x1F means the short message was completed (delivered); 0x20-0x3F still trying; 0x40+ failed.
function statusReport(t) {
  if (t.length < 4) throw new Error('SMS-STATUS-REPORT too short');
  let q = 1;
  const mr = t[q++];
  const raDigits = t[q++];
  q += 1; // type of address
  const recipient = unbcd(t.slice(q, q + Math.ceil(raDigits / 2))).slice(0, raDigits);
  q += Math.ceil(raDigits / 2) + 7 + 7; // TP-SCTS, TP-DT
  if (q >= t.length) throw new Error('SMS-STATUS-REPORT has no TP-ST');
  const st = t[q];
  const outcome = st < 0x20 ? 'delivered' : st < 0x40 ? 'pending' : 'failed';
  const stHex = st.toString(16).padStart(2, '0').toUpperCase();
  return { kind: 'status-report', from: recipient, mr, st, outcome, text: `Status report: message ${mr} to ${recipient} ${outcome} (TP-ST ${stHex})` };
}

module.exports = { moSubmit, rpAck, rpError, parseMt, pack7, unpack7, bcd, unbcd, RP };
