// Boundary decoder (FLUX 05f8eb0a-α): diagnoses every message that crosses the AMF boundary and names the hop and
// the owning team when a peer breaks the agreed contract. Pure functions, no I/O.
// verdict: 'ok' | 'expected' (a negative case the test data asks for) | 'fault' (a peer broke the contract)

const sms = require('./sms');

const OWNER = { nrf: 'smsf-hao', smsf: 'krilju', udm: 'hetoteam', smsc: 'holminator' };

// Negative cases the hetoteam test subscribers are built for (projects/hetoteam/CONTRACT.md).
const EXPECTED = {
  activate: { 'imsi-001010000000003': 'SMS_NOT_ALLOWED', 'imsi-001019999999999': 'USER_UNKNOWN' },
  sendsms: { 'imsi-001010000000005': 'MO_SMS_BARRED' },
};

const ok = () => ({ verdict: 'ok' });
const expected = finding => ({ verdict: 'expected', finding });
const fault = (hop, owner, finding, expect) => ({ verdict: 'fault', hop, owner, finding, expected: expect });

// Which peer behind the SMSF caused an SMSF error, judged from its cause/detail text.
function blame(body) {
  const t = `${(body && body.cause) || ''} ${(body && body.detail) || ''}`;
  if (/SMSC/i.test(t)) return ['SMSF→SMSC', OWNER.smsc];
  if (/UDM|UECM|SDM/i.test(t)) return ['SMSF→UDM', OWNER.udm];
  if (/NRF|DISCOVERY/i.test(t)) return ['SMSF→NRF', OWNER.smsf];
  return ['AMF→SMSF', OWNER.smsf];
}

// RP layer check for a payload the SMSF sends to the UE (TS 24.011 7.3: RP-DATA network to MS, MTI 1).
function mtPayload(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) {
    return fault('SMSF→AMF', OWNER.smsf, 'smsPayload.hex is not a hex string', 'hex RP-DATA network to MS');
  }
  const first = parseInt(hex.slice(0, 2), 16);
  try {
    sms.parseMt(hex);
    return ok();
  } catch (e) {
    const mti = first & 0x07;
    // An SMS-DELIVER TPDU has TP-MTI 00 in bits 0-1 and a TP-OA length as the second octet, never an RP MTI 1.
    if (mti !== 1 && (first & 0x03) === 0) {
      return fault('SMSF→AMF', OWNER.smsf, 'bare SMS-DELIVER TPDU, RP-DATA header missing', 'RP-DATA network to MS (MTI 1) wrapping the TPDU');
    }
    if (mti !== 1) return fault('SMSF→AMF', OWNER.smsf, `RP MTI ${mti}, not RP-DATA network to MS`, 'RP MTI 1');
    return fault('SMSF→AMF', OWNER.smsf, `RP-DATA does not decode: ${e.message}`, 'valid RP-DATA with SMS-DELIVER');
  }
}

// Incoming N1N2MessageTransfer from the SMSF (TS 29.518 6.1.6.2.27).
function n1n2(body) {
  if (!body || typeof body !== 'object') return fault('SMSF→AMF', OWNER.smsf, 'body is not JSON', 'N1N2MessageTransferReqData');
  const cls = body.n1MessageContainer && body.n1MessageContainer.n1MessageClass;
  if (cls !== 'SMS') return fault('SMSF→AMF', OWNER.smsf, `n1MessageClass is ${cls === undefined ? 'missing' : cls}`, 'n1MessageClass SMS');
  if (!body.smsPayload || !body.smsPayload.hex) return fault('SMSF→AMF', OWNER.smsf, 'smsPayload.hex is missing', 'smsPayload.hex');
  if (!body.smsRecordId) return fault('SMSF→AMF', OWNER.smsf, 'smsRecordId is missing, the RP-ACK cannot be correlated', 'smsRecordId');
  return mtPayload(body.smsPayload.hex);
}

// A response from the SMSF to our Activate / UplinkSMS / Deactivate call.
function smsfResponse(op, supi, status, body) {
  const cause = body && body.cause;
  const want = EXPECTED[op] && EXPECTED[op][supi];
  if (status === 0) return fault('AMF→SMSF', OWNER.smsf, 'no answer (timeout or connection refused)', 'an HTTP answer within 8 s');
  if (want) {
    if (cause === want) return expected(`${want}, as the test data says`);
    return fault(...blame(body), `got ${status} ${cause || ''}`.trim(), `${want} for ${supi}`);
  }
  const good = { activate: [200, 201], sendsms: [200], deactivate: [204] }[op] || [200];
  if (good.includes(status)) return ok();
  return fault(...blame(body), `${status} ${cause || ''}${body && body.detail ? `: ${body.detail}` : ''}`.trim(), `${good.join(' or ')}`);
}

// An NRF discovery result (TS 29.510 6.2.6.2.2). Checks that the profile can actually be called.
function discovery(targetType, status, body) {
  if (status !== 200) return fault('AMF→NRF', OWNER.nrf, `discovery answered ${status}`, '200 SearchResult');
  const list = body && body.nfInstances;
  if (!Array.isArray(list)) return fault('AMF→NRF', OWNER.nrf, 'nfInstances is missing', 'SearchResult.nfInstances array');
  if (!list.length) return fault('AMF→NRF', OWNER.smsf, `no ${targetType} registered`, `a REGISTERED ${targetType} profile`);
  const inst = list[0];
  if (inst.nfType && inst.nfType !== targetType) return fault('AMF→NRF', OWNER.nrf, `asked for ${targetType}, got nfType ${inst.nfType}`, `nfType ${targetType}`);
  const svc = (inst.nfServices || [])[0];
  if (!svc) return fault('AMF→NRF', OWNER.smsf, `${targetType} profile has no nfServices`, 'nfServices with apiRoot or apiPrefix');
  if (!svc.apiRoot && !/^https?:\/\//.test(svc.apiPrefix || '') && !inst.fqdn) {
    return fault('AMF→NRF', OWNER.smsf, `${targetType} profile has no apiRoot, absolute apiPrefix or fqdn`, 'a callable address');
  }
  return ok();
}

// A drafted #build fault report in the agreed format: what was sent, what was expected, what came back.
function report(entry) {
  const d = entry.diag;
  return `@${d.owner} fault on ${d.hop}. Sent/seen: ${entry.method} ${entry.path}. Expected: ${d.expected}. Got: ${d.finding}. (tompa boundary decoder, log id ${entry.id})`;
}

module.exports = { OWNER, EXPECTED, n1n2, mtPayload, smsfResponse, discovery, report };
