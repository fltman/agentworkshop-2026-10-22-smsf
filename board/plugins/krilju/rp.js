// TS 24.011 RP layer between UE and SMSF. The SMSF to SMSC leg carries the bare TS 23.040 TPDU.
const hex = bytes => Buffer.from(bytes).toString('hex').toUpperCase();

function bcd(digits) {
  const d = String(digits).replace(/\D/g, '');
  const out = [];
  for (let i = 0; i < d.length; i += 2) out.push(((i + 1 < d.length ? Number(d[i + 1]) : 0xf) << 4) | Number(d[i]));
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

// Parse an RP message from the UE (MS to network). Returns null if it is not well formed.
//   RP-DATA (MTI 0): { type: 'DATA', rpMr, scAddress, tpdu }
//   RP-ACK  (MTI 2): { type: 'ACK',  rpMr, tpdu? }   RP-ERROR (MTI 4): { type: 'ERROR', rpMr, cause, tpdu? }
function parseFromUe(hexStr) {
  const b = [...Buffer.from(String(hexStr), 'hex')];
  if (b.length < 2) return null;
  const mti = b[0] & 7;
  const rpMr = b[1];
  if (mti === 0) {
    let p = 2;
    p += 1 + b[p]; // RP-OA, empty from the MS
    const daLen = b[p++];
    const scAddress = daLen > 1 ? unbcd(b.slice(p + 1, p + daLen)) : '';
    p += daLen;
    const udLen = b[p++];
    if (p + udLen > b.length || !udLen) return null;
    return { type: 'DATA', rpMr, scAddress, tpdu: hex(b.slice(p, p + udLen)) };
  }
  if (mti === 2 || mti === 4) {
    let p = 2, cause = null;
    if (mti === 4) { const l = b[p++]; cause = b[p]; p += l; }
    let tpdu = null;
    if (b[p] === 0x41 && p + 1 < b.length) tpdu = hex(b.slice(p + 2, p + 2 + b[p + 1]));
    return { type: mti === 2 ? 'ACK' : 'ERROR', rpMr, cause, tpdu };
  }
  return null;
}

const ud = tpdu => { const t = [...Buffer.from(tpdu, 'hex')]; return [0x41, t.length, ...t]; };

// RP-ACK network to MS (MTI 3), optionally with the SMS-SUBMIT-REPORT TPDU.
const rpAck = (rpMr, tpdu) => hex([3, rpMr & 0xff, ...(tpdu ? ud(tpdu) : [])]);

// RP-ERROR network to MS (MTI 5), optionally with a SUBMIT-REPORT TPDU (carries TP-FCS).
const rpError = (rpMr, cause, tpdu) => hex([5, rpMr & 0xff, 0x01, cause & 0x7f, ...(tpdu ? ud(tpdu) : [])]);

// RP-DATA network to MS (MTI 1): RP-OA = SC address, RP-DA empty, RP-UD = SMS-DELIVER TPDU.
function rpDataToUe(rpMr, scAddress, tpdu) {
  const oa = bcd(scAddress);
  const t = [...Buffer.from(tpdu, 'hex')];
  return hex([1, rpMr & 0xff, oa.length + 1, 0x91, ...oa, 0x00, t.length, ...t]);
}

module.exports = { parseFromUe, rpAck, rpError, rpDataToUe };
